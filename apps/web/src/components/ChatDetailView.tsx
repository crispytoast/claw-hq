import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";

interface Props {
  client: GatewayClient;
  chatId: string;
  projectSlug: string | null;
  status: ConnectionStatus;
  onTitleChange?(chatId: string, title: string): void;
}

interface PersistedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdMs: number;
}

interface PersistedChat {
  id: string;
  projectSlug: string | null;
  title: string;
  createdMs: number;
  updatedMs: number;
  messages: PersistedMessage[];
}

interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streaming?: boolean;
}

function newId(): string {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const obj = part as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
  }
  return parts.join("");
}

function sessionKeyFor(chatId: string): string {
  // Deterministic per-chat OpenClaw session so reloads continue the same context
  // when the underlying session is still warm on the agent.
  return `agent:main:clawhq-${chatId.slice(0, 8)}`;
}

// Cap the memory blob so we don't blow OpenClaw's prompt window on huge briefs.
const MEMORY_CHAR_BUDGET = 8000;

function clip(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n\n…[truncated to ${budget} chars]`;
}

interface ProjectGetResult {
  summary?: { id?: string; name?: string };
  docs?: { brief?: string; memoryIndex?: string };
}

async function buildMemoryPreamble(
  client: GatewayClient,
  projectSlug: string | null,
): Promise<string> {
  if (!projectSlug) return "";
  try {
    const result = await client.call<ProjectGetResult>("clawhq.projects.get", {
      slug: projectSlug,
    });
    const name = result.summary?.name ?? projectSlug;
    const brief = (result.docs?.brief ?? "").trim();
    const memoryIndex = (result.docs?.memoryIndex ?? "").trim();
    if (!brief && !memoryIndex) return "";
    const briefBudget = Math.floor(MEMORY_CHAR_BUDGET * 0.7);
    const indexBudget = MEMORY_CHAR_BUDGET - briefBudget;
    const parts = [`[Project context — ${name}]`];
    if (brief) parts.push("", "## BRIEF.md", clip(brief, briefBudget));
    if (memoryIndex) parts.push("", "## memory/INDEX.md", clip(memoryIndex, indexBudget));
    parts.push("", "---", "");
    return parts.join("\n");
  } catch (err) {
    console.warn("clawhq.projects.get failed; sending without project memory:", err);
    return "";
  }
}

export function ChatDetailView({ client, chatId, projectSlug, status, onTitleChange }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [chatTitle, setChatTitle] = useState<string>("");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** runId -> id of the streaming assistant bubble */
  const streamMapRef = useRef<Map<string, string>>(new Map());
  /** Set after we successfully append a memory preamble, so we don't re-inject. */
  const memoryInjectedRef = useRef(false);
  const sessionKey = useMemo(() => sessionKeyFor(chatId), [chatId]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Load persisted chat history.
  useEffect(() => {
    if (status.kind !== "ready") return;
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    setErr("");
    memoryInjectedRef.current = false;
    streamMapRef.current.clear();
    void (async () => {
      try {
        const result = await client.call<{ chat: PersistedChat }>(
          "clawhq.chats.history",
          { chatId },
        );
        if (cancelled) return;
        const chat = result.chat;
        setChatTitle(chat.title);
        const display: DisplayMessage[] = chat.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.content,
        }));
        setMessages(display);
        // If we already have prior turns, the agent session was primed before —
        // assume memory's already in context.
        if (chat.messages.some((m) => m.role === "user")) {
          memoryInjectedRef.current = true;
        }
      } catch (e) {
        console.warn("clawhq.chats.history failed:", e);
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, chatId, status.kind]);

  // Listen for streaming assistant deltas for our sessionKey.
  useEffect(() => {
    return client.onEvent((ev: OpenClawEvent) => {
      if (ev.event !== "chat") return;
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const evSessionKey = typeof p.sessionKey === "string" ? p.sessionKey : null;
      if (evSessionKey && evSessionKey !== sessionKey) return;
      const runId = typeof p.runId === "string" ? p.runId : null;
      const state = typeof p.state === "string" ? p.state : "delta";
      const messageObj = (p.message ?? null) as Record<string, unknown> | null;
      const role = messageObj && typeof messageObj.role === "string" ? messageObj.role : "assistant";
      const text = messageObj ? contentToText(messageObj.content) : "";
      if (role !== "assistant") return;

      setMessages((prev) => {
        const bubbleId = runId ? streamMapRef.current.get(runId) : undefined;
        if (bubbleId) {
          return prev.map((m) =>
            m.id === bubbleId
              ? { ...m, text, streaming: state !== "final" }
              : m,
          );
        }
        const newBubbleId = newId();
        if (runId) streamMapRef.current.set(runId, newBubbleId);
        return [...prev, { id: newBubbleId, role: "assistant", text, streaming: state !== "final" }];
      });

      if (state === "final") {
        setPending(false);
        // Persist the final assistant text so it survives reload.
        if (text) {
          void client
            .call("clawhq.chats.append", {
              chatId,
              role: "assistant",
              content: text,
            })
            .catch((e) => {
              console.warn("clawhq.chats.append (assistant) failed:", e);
            });
        }
        if (runId) {
          setTimeout(() => streamMapRef.current.delete(runId), 1000);
        }
      }
    });
  }, [client, sessionKey, chatId]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || status.kind !== "ready" || pending) return;
    setInput("");
    setErr("");
    setPending(true);

    // Optimistic user bubble.
    const optimistic: DisplayMessage = { id: newId(), role: "user", text };
    setMessages((prev) => [...prev, optimistic]);

    try {
      // 1) Persist user turn.
      await client.call("clawhq.chats.append", {
        chatId,
        role: "user",
        content: text,
      });

      // 2) On the first user turn (this page session), prepend project memory
      //    so OpenClaw answers with full project context. Subsequent turns rely
      //    on the agent session's own retained memory.
      let payload = text;
      if (!memoryInjectedRef.current) {
        const preamble = await buildMemoryPreamble(client, projectSlug);
        if (preamble) payload = `${preamble}${text}`;
        memoryInjectedRef.current = true;
      }

      // 3) Send to OpenClaw. Assistant reply streams in via the chat event handler.
      await client.call("chat.send", {
        sessionKey,
        message: payload,
        idempotencyKey: `clawhq-${chatId}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: "system", text: `Send failed: ${msg}` },
      ]);
      setPending(false);
    }
  }, [client, chatId, projectSlug, sessionKey, input, status.kind, pending]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  // Notify parent of title (Sidebar refresh hook); fires only when it actually changes.
  useEffect(() => {
    if (chatTitle && onTitleChange) onTitleChange(chatId, chatTitle);
  }, [chatTitle, chatId, onTitleChange]);

  const canSend = status.kind === "ready" && input.trim().length > 0 && !pending;

  return (
    <>
      <div className="message-list" ref={listRef}>
        {loading && (
          <div className="empty">
            <div className="big">⏳</div>
            Loading chat…
          </div>
        )}
        {!loading && messages.length === 0 && status.kind === "ready" && (
          <div className="empty">
            <div className="big">💬</div>
            Send your first message
            {projectSlug ? <> — project context for <code>{projectSlug}</code> will be attached.</> : null}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.role === "system" && <span className="role-tag">system</span>}
            {m.text}
            {m.streaming && <span className="spinner" style={{ marginLeft: "0.5rem" }} />}
          </div>
        ))}
        {err && <div className="bubble system">{err}</div>}
      </div>

      <div className="composer">
        <div className="row">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              status.kind === "ready"
                ? projectSlug
                  ? `Message about ${projectSlug}…`
                  : "Message OpenClaw…"
                : status.kind === "agent-offline"
                  ? "Tunnel offline — start the agent on your OpenClaw machine"
                  : "Connecting…"
            }
            disabled={status.kind !== "ready" || pending}
            rows={1}
          />
          <button
            className="send"
            onClick={() => void sendMessage()}
            disabled={!canSend}
            aria-label="send"
          >
            {pending ? <span className="spinner" /> : "↑"}
          </button>
        </div>
      </div>
    </>
  );
}
