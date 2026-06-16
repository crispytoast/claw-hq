import { useEffect, useRef, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";
import { Chat, ArrowUp } from "./icons.js";

interface Props {
  client: GatewayClient;
  sessionKey: string;
  status: ConnectionStatus;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  /** True while the assistant is still streaming. */
  streaming?: boolean;
}

function newMessageId(): string {
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Extract a plain text snippet from an OpenClaw message.content array.
 */
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

export function ChatPane({ client, sessionKey, status }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  /** runId -> id of the streaming assistant bubble */
  const streamMapRef = useRef<Map<string, string>>(new Map());

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Load chat history once the session is ready.
  useEffect(() => {
    if (status.kind !== "ready") return;
    let cancelled = false;
    setMessages([]);
    setErr("");
    void (async () => {
      try {
        const history = await client.call<{ messages?: unknown[]; entries?: unknown[] }>(
          "chat.history",
          { sessionKey, maxItems: 100 },
        );
        if (cancelled) return;
        const raw = (history.messages ?? history.entries ?? []) as Array<Record<string, unknown>>;
        const display: DisplayMessage[] = raw
          .map((row): DisplayMessage | null => {
            const role = typeof row.role === "string" ? row.role : "assistant";
            const text =
              typeof row.text === "string"
                ? row.text
                : typeof row.content === "string"
                  ? row.content
                  : contentToText(row.content);
            if (!text || (role !== "user" && role !== "assistant" && role !== "system")) return null;
            return { id: newMessageId(), role: role as DisplayMessage["role"], text };
          })
          .filter((m): m is DisplayMessage => m !== null);
        setMessages(display);
      } catch (e) {
        console.warn("chat.history failed:", e);
        // Empty history is fine — likely a new session.
      }
    })();

    // Subscribe to session message events for cross-device live updates.
    void client.call("sessions.messages.subscribe", { sessionKey }).catch((e) => {
      console.warn("sessions.messages.subscribe failed:", e);
    });

    return () => {
      cancelled = true;
      // Best-effort unsubscribe; not awaited.
      client.call("sessions.messages.unsubscribe", { sessionKey }).catch(() => { /* noop */ });
    };
  }, [client, sessionKey, status.kind]);

  // Wire up streaming + history events.
  useEffect(() => {
    return client.onEvent((ev: OpenClawEvent) => {
      if (ev.event === "chat") {
        const p = (ev.payload ?? {}) as Record<string, unknown>;
        const evSessionKey = typeof p.sessionKey === "string" ? p.sessionKey : null;
        if (evSessionKey && evSessionKey !== sessionKey) return;
        const runId = typeof p.runId === "string" ? p.runId : null;
        const state = typeof p.state === "string" ? p.state : "delta";
        const messageObj = (p.message ?? null) as Record<string, unknown> | null;
        const role = messageObj && typeof messageObj.role === "string" ? messageObj.role : "assistant";
        const text = messageObj ? contentToText(messageObj.content) : "";

        // Only consider assistant messages for streaming; users come from our own chat.send echo.
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
          // First chunk for this run — create bubble.
          const newId = newMessageId();
          if (runId) streamMapRef.current.set(runId, newId);
          return [...prev, { id: newId, role: "assistant", text, streaming: state !== "final" }];
        });

        if (state === "final" && runId) {
          // After a tick, drop the run mapping.
          setTimeout(() => streamMapRef.current.delete(runId), 1000);
          setPending(false);
        }
        return;
      }

      // session.message updates from cross-device — refresh history snippet.
      if (ev.event === "session.message") {
        const p = (ev.payload ?? {}) as Record<string, unknown>;
        const evSessionKey = typeof p.sessionKey === "string" ? p.sessionKey : null;
        if (evSessionKey && evSessionKey !== sessionKey) return;
        const messageObj = (p.message ?? null) as Record<string, unknown> | null;
        if (!messageObj) return;
        const role = typeof messageObj.role === "string" ? messageObj.role : null;
        if (role !== "user") return;
        const text = contentToText(messageObj.content);
        if (!text) return;
        // Avoid duplicating our own send (we add the user bubble optimistically).
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "user" && last.text === text) return prev;
          return [...prev, { id: newMessageId(), role: "user", text }];
        });
      }
    });
  }, [client, sessionKey]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || status.kind !== "ready") return;
    setInput("");
    setErr("");
    setPending(true);
    const optimistic: DisplayMessage = { id: newMessageId(), role: "user", text };
    setMessages((prev) => [...prev, optimistic]);
    try {
      await client.call("chat.send", {
        sessionKey,
        message: text,
        idempotencyKey: `claw-hq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      setMessages((prev) => [
        ...prev,
        { id: newMessageId(), role: "system", text: `Send failed: ${msg}` },
      ]);
      setPending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const canSend = status.kind === "ready" && input.trim().length > 0 && !pending;

  return (
    <>
      <div className="message-list" ref={listRef}>
        {messages.length === 0 && status.kind === "ready" && (
          <div className="empty">
            <div className="big"><Chat size={28} /></div>
            Send your first message to <code>{sessionKey}</code>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.role === "tool" && <span className="role-tag">tool</span>}
            {m.role === "system" && <span className="role-tag">system</span>}
            {m.text}
            {m.streaming && <span className="spinner" style={{ marginLeft: "0.5rem" }} />}
          </div>
        ))}
        {err && (
          <div className="bubble system">{err}</div>
        )}
      </div>

      <div className="composer">
        <div className="row">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              status.kind === "ready"
                ? "Message OpenClaw…"
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
            {pending ? <span className="spinner" /> : <ArrowUp size={15} />}
          </button>
        </div>
      </div>
    </>
  );
}
