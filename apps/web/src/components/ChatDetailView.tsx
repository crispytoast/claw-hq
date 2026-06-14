import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";

interface UploadedAttachment {
  /** Local-only id so we can dedupe + drop entries from the pending list. */
  localId: string;
  /** SHA-256 returned by /api/uploads. */
  uploadId: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Kept so we can re-read bytes as base64 for chat.send. */
  file: File;
  /** Local blob: URL for image previews. Revoke when the chip is removed. */
  previewUrl?: string;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  // btoa over a binary string. Build it from a Uint8Array.
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

interface UploadResponse {
  id: string;
  url: string;
  mimeType: string;
  filename: string;
  size: number;
}

async function uploadFile(file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch("/api/uploads", { method: "POST", body: fd, credentials: "same-origin" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload failed: ${res.status} ${text.slice(0, 80)}`);
  }
  return res.json() as Promise<UploadResponse>;
}

function newLocalId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface Props {
  client: GatewayClient;
  chatId: string;
  projectSlug: string | null;
  status: ConnectionStatus;
  onTitleChange?(chatId: string, title: string): void;
  /**
   * If set, render `<mark>` highlights around case-insensitive matches in every
   * message bubble + auto-scroll to the first match once items have loaded.
   * Threaded through from the sidebar search → ChatApp → here.
   */
  initialSearchQuery?: string;
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

interface DisplayTool {
  toolCallId: string;
  name: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  status: "running" | "done" | "error";
  startedMs: number;
  doneMs?: number;
}

type DisplayItem =
  | { kind: "message"; message: DisplayMessage }
  | { kind: "tool"; tool: DisplayTool };

function itemKey(item: DisplayItem): string {
  return item.kind === "message" ? `m:${item.message.id}` : `t:${item.tool.toolCallId}`;
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

export function ChatDetailView({ client, chatId, projectSlug, status, onTitleChange, initialSearchQuery }: Props) {
  const [items, setItems] = useState<DisplayItem[]>([]);
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
  /** Message ids we just persisted via clawhq.chats.append; lets us drop our own broadcast echo. */
  const recentlyPersistedIdsRef = useRef<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionKey = useMemo(() => sessionKeyFor(chatId), [chatId]);

  const noteOwnPersist = useCallback((id: string) => {
    recentlyPersistedIdsRef.current.add(id);
    setTimeout(() => recentlyPersistedIdsRef.current.delete(id), 10_000);
  }, []);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      for (const file of list) {
        const localId = newLocalId();
        setUploading((s) => new Set(s).add(localId));
        try {
          const res = await uploadFile(file);
          const isImage = res.mimeType.startsWith("image/");
          let previewUrl: string | undefined;
          if (isImage) {
            previewUrl = URL.createObjectURL(file);
            previewUrlsRef.current.add(previewUrl);
          }
          const next: UploadedAttachment = {
            localId,
            uploadId: res.id,
            url: res.url,
            filename: res.filename,
            mimeType: res.mimeType,
            size: res.size,
            file,
            previewUrl,
          };
          setAttachments((prev) => [...prev, next]);
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        } finally {
          setUploading((s) => {
            const next = new Set(s);
            next.delete(localId);
            return next;
          });
        }
      }
    },
    [],
  );

  // Track all blob: URLs we've created so we can revoke on unmount without
  // chasing the latest `attachments` snapshot from a stale closure.
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const revokePreviewUrl = useCallback((url: string | undefined) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    previewUrlsRef.current.delete(url);
  }, []);

  const removeAttachment = useCallback(
    (localId: string) => {
      setAttachments((prev) => {
        const target = prev.find((a) => a.localId === localId);
        revokePreviewUrl(target?.previewUrl);
        return prev.filter((a) => a.localId !== localId);
      });
    },
    [revokePreviewUrl],
  );

  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current.clear();
    };
  }, []);

  // Track whether we've consumed the initial search query for THIS chat load.
  // Once we've scrolled to the first match (or confirmed there isn't one), we
  // stop hijacking the bottom-scroll behavior so new turns auto-scroll normally.
  const searchScrolledRef = useRef(false);
  useEffect(() => {
    searchScrolledRef.current = false;
  }, [chatId, initialSearchQuery]);

  // Auto-scroll: on first load with a search query, scroll to the first
  // matching message; otherwise (and after) scroll to bottom on new items.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (
      initialSearchQuery &&
      initialSearchQuery.trim() &&
      !searchScrolledRef.current &&
      items.some((it) => it.kind === "message")
    ) {
      const q = initialSearchQuery.toLowerCase();
      const hit = items.find(
        (it) => it.kind === "message" && it.message.text.toLowerCase().includes(q),
      );
      if (hit && hit.kind === "message") {
        const node = el.querySelector(
          `[data-message-id="${CSS.escape(hit.message.id)}"]`,
        ) as HTMLElement | null;
        if (node) {
          node.scrollIntoView({ block: "center", behavior: "auto" });
          node.classList.add("bubble-flash");
          setTimeout(() => node.classList.remove("bubble-flash"), 1600);
          searchScrolledRef.current = true;
          return;
        }
      }
      // No match — fall through to bottom scroll and don't try again.
      searchScrolledRef.current = true;
    }
    el.scrollTop = el.scrollHeight;
  }, [items, initialSearchQuery]);

  // Load persisted chat history.
  useEffect(() => {
    if (status.kind !== "ready") return;
    let cancelled = false;
    setLoading(true);
    setItems([]);
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
        const display: DisplayItem[] = chat.messages.map((m) => ({
          kind: "message" as const,
          message: { id: m.id, role: m.role, text: m.content },
        }));
        setItems(display);
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

      setItems((prev) => {
        const bubbleId = runId ? streamMapRef.current.get(runId) : undefined;
        if (bubbleId) {
          return prev.map((it) =>
            it.kind === "message" && it.message.id === bubbleId
              ? { kind: "message" as const, message: { ...it.message, text, streaming: state !== "final" } }
              : it,
          );
        }
        const newBubbleId = newId();
        if (runId) streamMapRef.current.set(runId, newBubbleId);
        return [
          ...prev,
          {
            kind: "message" as const,
            message: { id: newBubbleId, role: "assistant", text, streaming: state !== "final" },
          },
        ];
      });

      if (state === "final") {
        setPending(false);
        // Persist the final assistant text so it survives reload.
        if (text) {
          void client
            .call<{ message?: { id?: string } }>("clawhq.chats.append", {
              chatId,
              role: "assistant",
              content: text,
            })
            .then((result) => {
              if (result?.message?.id) noteOwnPersist(result.message.id);
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
  }, [client, sessionKey, chatId, noteOwnPersist]);

  // Tool call events for our sessionKey. We're already globally subscribed via
  // gateway.ts on session_ready; here we just filter to this chat's session.
  useEffect(() => {
    return client.onEvent((ev: OpenClawEvent) => {
      if (ev.event !== "session.tool") return;
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const evSessionKey = typeof p.sessionKey === "string" ? p.sessionKey : null;
      if (evSessionKey && evSessionKey !== sessionKey) return;
      const data = (p.data ?? {}) as Record<string, unknown>;
      const phase = typeof data.phase === "string" ? data.phase : null;
      const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : null;
      if (!phase || !toolCallId) return;
      const name = typeof data.name === "string" ? data.name : "tool";
      const ts = typeof p.ts === "number" ? p.ts : Date.now();

      if (phase === "start") {
        const args = data.args;
        setItems((prev) => {
          if (prev.some((it) => it.kind === "tool" && it.tool.toolCallId === toolCallId)) {
            return prev;
          }
          return [
            ...prev,
            {
              kind: "tool",
              tool: { toolCallId, name, args, status: "running", startedMs: ts },
            },
          ];
        });
        return;
      }
      if (phase === "result") {
        const result = data.result;
        const isError = data.isError === true;
        setItems((prev) => {
          const idx = prev.findIndex((it) => it.kind === "tool" && it.tool.toolCallId === toolCallId);
          if (idx === -1) {
            // Late result without a start (rare; surface anyway).
            return [
              ...prev,
              {
                kind: "tool",
                tool: {
                  toolCallId,
                  name,
                  args: undefined,
                  result,
                  isError,
                  status: isError ? "error" : "done",
                  startedMs: ts,
                  doneMs: ts,
                },
              },
            ];
          }
          const next = [...prev];
          const existing = next[idx]!;
          if (existing.kind !== "tool") return prev;
          next[idx] = {
            kind: "tool",
            tool: {
              ...existing.tool,
              result,
              isError,
              status: isError ? "error" : "done",
              doneMs: ts,
            },
          };
          return next;
        });
        return;
      }
    });
  }, [client, sessionKey]);

  // Cross-device live feed — broadcasts emitted by clawhq.chats.append on any
  // device land here. Skip our own echoes; otherwise append the new bubble.
  useEffect(() => {
    return client.onEvent((ev: OpenClawEvent) => {
      if (ev.event === "plugin.clawhq.chat.message") {
        const p = (ev.payload ?? {}) as {
          chatId?: unknown;
          message?: unknown;
        };
        if (p.chatId !== chatId) return;
        const msg = p.message as PersistedMessage | undefined;
        if (!msg || typeof msg.id !== "string") return;
        if (recentlyPersistedIdsRef.current.has(msg.id)) return;
        // Treat any inbound user turn as evidence the agent session is primed.
        if (msg.role === "user") memoryInjectedRef.current = true;
        setItems((prev) => {
          if (prev.some((it) => it.kind === "message" && it.message.id === msg.id)) return prev;
          return [
            ...prev,
            { kind: "message" as const, message: { id: msg.id, role: msg.role, text: msg.content } },
          ];
        });
        return;
      }
      if (ev.event === "plugin.clawhq.chat.renamed") {
        const p = (ev.payload ?? {}) as { chatId?: unknown; title?: unknown };
        if (p.chatId !== chatId || typeof p.title !== "string") return;
        setChatTitle(p.title);
      }
    });
  }, [client, chatId]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const pendingAttachments = attachments;
    if (!text && pendingAttachments.length === 0) return;
    if (status.kind !== "ready" || pending) return;
    setInput("");
    setErr("");
    setPending(true);
    for (const a of pendingAttachments) revokePreviewUrl(a.previewUrl);
    setAttachments([]);

    // Build the persisted body — annotate each attachment with an inline link so
    // chat history shows what was sent and lets the user re-open the upload.
    const attachmentLines = pendingAttachments.map(
      (a) => `[📎 ${a.filename}](${a.url})`,
    );
    const persistedBody = [text, ...attachmentLines].filter(Boolean).join("\n\n");
    const displayText = persistedBody || "(attachment)";

    // Optimistic user bubble.
    const optimistic: DisplayMessage = { id: newId(), role: "user", text: displayText };
    setItems((prev) => [...prev, { kind: "message", message: optimistic }]);

    try {
      const appendResult = await client.call<{ message?: { id?: string } }>(
        "clawhq.chats.append",
        { chatId, role: "user", content: persistedBody || `[attachment x${pendingAttachments.length}]` },
      );
      if (appendResult?.message?.id) noteOwnPersist(appendResult.message.id);

      let payload = text || "(see attached files)";
      if (!memoryInjectedRef.current) {
        const preamble = await buildMemoryPreamble(client, projectSlug);
        if (preamble) payload = `${preamble}${payload}`;
        memoryInjectedRef.current = true;
      }

      // Convert each pending attachment to OpenClaw's chat.send shape. We use
      // the canonical `source: {type: "base64", media_type, data}` form so the
      // gateway normalizer treats it as an inline upload.
      const oclawAttachments = await Promise.all(
        pendingAttachments.map(async (a) => ({
          type: a.mimeType.startsWith("image/") ? "image" : "file",
          mimeType: a.mimeType,
          fileName: a.filename,
          source: {
            type: "base64",
            media_type: a.mimeType,
            data: await fileToBase64(a.file),
          },
        })),
      );

      const sendParams: Record<string, unknown> = {
        sessionKey,
        message: payload,
        idempotencyKey: `clawhq-${chatId}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
      };
      if (oclawAttachments.length > 0) sendParams.attachments = oclawAttachments;
      await client.call("chat.send", sendParams);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      setItems((prev) => [
        ...prev,
        {
          kind: "message",
          message: { id: newId(), role: "system", text: `Send failed: ${msg}` },
        },
      ]);
      setPending(false);
    }
  }, [client, chatId, projectSlug, sessionKey, input, attachments, status.kind, pending, noteOwnPersist, revokePreviewUrl]);

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

  const canSend =
    status.kind === "ready" &&
    !pending &&
    uploading.size === 0 &&
    (input.trim().length > 0 || attachments.length > 0);

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
  };

  return (
    <>
      <div
        className={`message-list ${dragOver ? "drag-over" : ""}`}
        ref={listRef}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {loading && (
          <div className="empty">
            <div className="big">⏳</div>
            Loading chat…
          </div>
        )}
        {!loading && items.length === 0 && status.kind === "ready" && (
          <div className="empty">
            <div className="big">💬</div>
            Send your first message
            {projectSlug ? <> — project context for <code>{projectSlug}</code> will be attached.</> : null}
          </div>
        )}
        {items.map((it) => {
          if (it.kind === "tool") {
            return <ToolBlock key={itemKey(it)} tool={it.tool} />;
          }
          const m = it.message;
          return (
            <div
              key={itemKey(it)}
              data-message-id={m.id}
              className={`bubble ${m.role}`}
            >
              {m.role === "system" && <span className="role-tag">system</span>}
              <BubbleContent text={m.text} highlight={initialSearchQuery} />
              {m.streaming && <span className="spinner" style={{ marginLeft: "0.5rem" }} />}
            </div>
          );
        })}
        {err && <div className="bubble system">{err}</div>}
        {dragOver && (
          <div className="drop-overlay">Drop to attach</div>
        )}
      </div>

      <div className="composer">
        {(attachments.length > 0 || uploading.size > 0) && (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <div key={a.localId} className="attachment-chip">
                {a.previewUrl ? (
                  <img
                    src={a.previewUrl}
                    alt={a.filename}
                    className="attachment-thumb"
                    onError={(e) => {
                      // If the blob URL can't decode, fall back to the icon.
                      e.currentTarget.style.display = "none";
                      const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
                      if (fallback) fallback.style.display = "";
                    }}
                  />
                ) : null}
                <span
                  className="attachment-icon"
                  style={{ display: a.previewUrl ? "none" : undefined }}
                >
                  {a.mimeType.startsWith("image/") ? "🖼️" : "📎"}
                </span>
                <span className="attachment-name" title={a.filename}>{a.filename}</span>
                <span className="attachment-size">{formatSize(a.size)}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove ${a.filename}`}
                  onClick={() => removeAttachment(a.localId)}
                >✕</button>
              </div>
            ))}
            {[...uploading].map((localId) => (
              <div key={localId} className="attachment-chip attachment-uploading">
                <span className="spinner" />
                <span className="attachment-name">uploading…</span>
              </div>
            ))}
          </div>
        )}
        <div className="row">
          <button
            type="button"
            className="composer-attach"
            aria-label="Attach files"
            title="Attach files"
            disabled={status.kind !== "ready" || pending}
            onClick={() => fileInputRef.current?.click()}
          >＋</button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
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

function formatToolValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function ToolBlock({ tool }: { tool: DisplayTool }) {
  const [open, setOpen] = useState(false);
  const statusClass =
    tool.status === "done" ? "ok" : tool.status === "error" ? "bad" : "warn";
  const statusLabel =
    tool.status === "running" ? "running" : tool.status === "error" ? "error" : "done";
  const subtitle = useMemo(() => {
    if (typeof tool.args === "object" && tool.args !== null) {
      // Surface the most common single-arg shape: { command, description }, etc.
      const a = tool.args as Record<string, unknown>;
      const cmd =
        typeof a.command === "string" ? a.command
        : typeof a.query === "string" ? a.query
        : typeof a.file_path === "string" ? a.file_path
        : typeof a.url === "string" ? a.url
        : typeof a.description === "string" ? a.description
        : null;
      if (cmd) return cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd;
    }
    return null;
  }, [tool.args]);
  const argsText = formatToolValue(tool.args);
  const resultText = formatToolValue(tool.result);
  const RESULT_INLINE_CAP = 4000;
  const truncated = resultText.length > RESULT_INLINE_CAP;
  return (
    <div className={`tool-block ${tool.status}`}>
      <button
        type="button"
        className="tool-block-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-block-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-block-icon">🔧</span>
        <span className="tool-block-name">{tool.name}</span>
        {subtitle && <span className="tool-block-subtitle">{subtitle}</span>}
        <span className={`status-pill ${statusClass}`}>
          <span className="status-dot" />
          {statusLabel}
        </span>
      </button>
      {open && (
        <div className="tool-block-body">
          {argsText && (
            <>
              <div className="tool-block-label">args</div>
              <pre className="tool-block-pre">{argsText}</pre>
            </>
          )}
          {tool.status !== "running" && (
            <>
              <div className="tool-block-label">
                {tool.isError ? "error" : "result"}
              </div>
              <pre className={`tool-block-pre ${tool.isError ? "tool-block-pre-error" : ""}`}>
                {truncated ? `${resultText.slice(0, RESULT_INLINE_CAP)}\n\n…[${resultText.length - RESULT_INLINE_CAP} more chars truncated]` : resultText || "(empty)"}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split `text` around case-insensitive matches of `query` and return a fragment
 * with each match wrapped in `<mark>`. If query is empty, returns the text as-is.
 */
function highlightText(text: string, query: string | undefined): React.ReactNode {
  if (!query) return text;
  const trimmed = query.trim();
  if (!trimmed) return text;
  let re: RegExp;
  try {
    re = new RegExp(escapeRegExp(trimmed), "gi");
  } catch {
    return text;
  }
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<mark key={`h-${m.index}`} className="bubble-hit">{m[0]}</mark>);
    last = m.index + m[0].length;
    // Defensive: zero-width match would loop forever.
    if (m[0].length === 0) re.lastIndex = last + 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Render bubble text with `[label](url)` links turned into clickable anchors so
 * attachment refs show up properly. No other markdown — we don't want to
 * over-interpret model output. Optionally highlights case-insensitive matches
 * of `highlight` with `<mark>`.
 */
function BubbleContent({ text, highlight }: { text: string; highlight?: string }) {
  const parts = useMemo(() => {
    const out: Array<{ kind: "text" | "link"; text: string; url?: string }> = [];
    const re = /\[([^\]]+)\]\(([^)]+)\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
      out.push({ kind: "link", text: m[1]!, url: m[2]! });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
    return out;
  }, [text]);
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "link" ? (
          <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className="bubble-link">
            {highlightText(p.text, highlight)}
          </a>
        ) : (
          <span key={i}>{highlightText(p.text, highlight)}</span>
        ),
      )}
    </>
  );
}
