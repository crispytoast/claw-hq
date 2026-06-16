import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";
import { lineDiff, parseFileEditArgs, statsFor, toHunks } from "./diff.js";
import type { DiffHunk, ParsedFileEdit } from "./diff.js";
import { extractHistoryAttachments, type HistoryAttachment } from "./history-attachments.js";

type AttachmentSource =
  | { kind: "file"; file: File }
  | { kind: "remote"; url: string };

interface UploadedAttachment {
  /** Local-only id so we can dedupe + drop entries from the pending list. */
  localId: string;
  /** SHA-256 returned by /api/uploads (or extracted from a history `/uploads/<id>` URL). */
  uploadId: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Where the bytes come from at send time. File = freshly picked; remote =
   *  re-attached from chat history. */
  source: AttachmentSource;
  /** Image-preview URL. For File sources this is a blob: URL we revoke; for
   *  remote sources it's the `/uploads/<id>` URL itself (nothing to revoke). */
  previewUrl?: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

async function attachmentBytesBase64(a: UploadedAttachment): Promise<string> {
  if (a.source.kind === "file") {
    return bytesToBase64(new Uint8Array(await a.source.file.arrayBuffer()));
  }
  const res = await fetch(a.source.url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`re-fetch upload failed: ${res.status}`);
  return bytesToBase64(new Uint8Array(await res.arrayBuffer()));
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
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdMs: number;
}

interface PersistedToolPayload {
  toolCallId: string;
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  startedMs?: number;
  doneMs?: number;
}

function parsePersistedTool(content: string): PersistedToolPayload | null {
  if (!content) return null;
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    if (typeof obj.toolCallId !== "string" || typeof obj.name !== "string") return null;
    return obj as unknown as PersistedToolPayload;
  } catch {
    return null;
  }
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

interface DisplayApproval {
  id: string;
  command?: string;
  cwd?: string;
  reason?: string;
  requestedMs: number;
  status: "pending" | "approved" | "denied";
  decisionMs?: number;
  busy?: boolean;
}

interface AskQuestionOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
}

interface DisplayQuestion {
  toolCallId: string;
  questions: AskQuestion[];
  status: "pending" | "answered";
  answer?: string;
  startedMs: number;
}

type DisplayItem =
  | { kind: "message"; message: DisplayMessage }
  | { kind: "tool"; tool: DisplayTool }
  | { kind: "approval"; approval: DisplayApproval }
  | { kind: "question"; question: DisplayQuestion };

function itemKey(item: DisplayItem): string {
  if (item.kind === "message") return `m:${item.message.id}`;
  if (item.kind === "tool") return `t:${item.tool.toolCallId}`;
  if (item.kind === "approval") return `a:${item.approval.id}`;
  return `q:${item.question.toolCallId}`;
}

function parseAskQuestionArgs(args: unknown): AskQuestion[] | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  const rawQs = obj.questions;
  if (!Array.isArray(rawQs)) return null;
  const out: AskQuestion[] = [];
  for (const q of rawQs) {
    if (!q || typeof q !== "object") continue;
    const qObj = q as Record<string, unknown>;
    const question = typeof qObj.question === "string" ? qObj.question : null;
    if (!question) continue;
    const rawOpts = Array.isArray(qObj.options) ? qObj.options : [];
    const options: AskQuestionOption[] = [];
    for (const opt of rawOpts) {
      if (!opt || typeof opt !== "object") continue;
      const oObj = opt as Record<string, unknown>;
      if (typeof oObj.label !== "string") continue;
      options.push({
        label: oObj.label,
        description: typeof oObj.description === "string" ? oObj.description : undefined,
      });
    }
    out.push({
      question,
      header: typeof qObj.header === "string" ? qObj.header : undefined,
      options,
      multiSelect: qObj.multiSelect === true,
    });
  }
  return out.length > 0 ? out : null;
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
  const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionKey = useMemo(() => sessionKeyFor(chatId), [chatId]);

  // Voice STT — driven by window.ClawHqVoiceBridge (Android-only). voiceAnchor
  // is the start offset in `input` where the live partial begins; everything
  // typed before mic-on is preserved. Same pattern as PM HQ's chat composer.
  const [listening, setListening] = useState(false);
  const voiceAnchorRef = useRef<number | null>(null);
  const inputRef = useRef("");
  inputRef.current = input;
  const voiceAvailable = typeof window !== "undefined"
    && typeof (window as unknown as { ClawHqVoiceBridge?: unknown }).ClawHqVoiceBridge !== "undefined";

  // Derive the list of prior uploads in this chat from the persisted bubbles
  // so the composer can offer a "re-attach from history" picker without a
  // round-trip. Recomputes when items change (new persisted attachments
  // appear after each successful send).
  const historyAttachmentTexts = useMemo(
    () => items.map((it) => (it.kind === "message" ? it.message.text : "")),
    [items],
  );
  const historyAttachments = useMemo(
    () => extractHistoryAttachments(historyAttachmentTexts),
    [historyAttachmentTexts],
  );
  const activeUploadIds = useMemo(
    () => new Set(attachments.map((a) => a.uploadId)),
    [attachments],
  );

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
            source: { kind: "file", file },
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
  // chasing the latest `attachments` snapshot from a stale closure. Remote
  // `/uploads/<id>` URLs from re-attached history aren't tracked here — those
  // belong to the relay, not our object-URL pool.
  const previewUrlsRef = useRef<Set<string>>(new Set());
  const revokePreviewUrl = useCallback((url: string | undefined) => {
    if (!url || !url.startsWith("blob:")) return;
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

  const addHistoryAttachment = useCallback(
    async (entry: HistoryAttachment) => {
      // Dedupe: if this upload is already on the composer, no-op.
      const already = attachments.some((a) => a.uploadId === entry.uploadId);
      if (already) return;
      try {
        // HEAD avoids re-downloading the file just to learn its mime + size for
        // the chip. The relay's static file route supports HEAD via fastify's
        // GET→HEAD shim.
        const head = await fetch(entry.url, { method: "HEAD", credentials: "same-origin" });
        if (!head.ok) throw new Error(`HEAD failed: ${head.status}`);
        const ct = head.headers.get("content-type") ?? "application/octet-stream";
        const mimeType = ct.split(";")[0]?.trim() ?? "application/octet-stream";
        const sizeStr = head.headers.get("content-length");
        const size = sizeStr ? Number.parseInt(sizeStr, 10) : 0;
        const isImage = mimeType.startsWith("image/");
        const next: UploadedAttachment = {
          localId: newLocalId(),
          uploadId: entry.uploadId,
          url: entry.url,
          filename: entry.filename,
          mimeType,
          size,
          source: { kind: "remote", url: entry.url },
          // For remote previews we reuse the `/uploads/<id>` URL directly; the
          // browser handles content negotiation. We don't add it to
          // previewUrlsRef because we don't own it (no revoke needed).
          previewUrl: isImage ? entry.url : undefined,
        };
        setAttachments((prev) => [...prev, next]);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [attachments],
  );

  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current.clear();
    };
  }, []);

  // Voice bridge callback hookup. The Android side calls
  // window.__clawHqVoiceCallback(JSON) so we register one stable handler that
  // routes by `type`. Re-registered when chatId changes so a stale chat's
  // textarea doesn't keep eating partials.
  useEffect(() => {
    if (!voiceAvailable) return;
    interface VoicePayload {
      type: "ready" | "partial" | "final" | "error" | "stopped" | "permission";
      text?: string;
      granted?: boolean;
    }
    const handler = (raw: string) => {
      let payload: VoicePayload;
      try { payload = JSON.parse(raw) as VoicePayload; } catch { return; }
      if (payload.type === "ready") return;
      if (payload.type === "stopped") return;
      if (payload.type === "permission") {
        if (payload.granted) {
          // Retry start now that the user granted the prompt.
          try {
            const bridge = (window as unknown as {
              ClawHqVoiceBridge?: { start(): boolean };
            }).ClawHqVoiceBridge;
            const ok = bridge?.start() ?? false;
            if (ok) setListening(true);
          } catch (e) { console.warn("voice start after permission failed:", e); }
        }
        return;
      }
      if (payload.type === "error") {
        setListening(false);
        voiceAnchorRef.current = null;
        if (payload.text) console.warn("voice:", payload.text);
        return;
      }
      // partial or final — splice the heard text into `input` from voiceAnchor on.
      const text = typeof payload.text === "string" ? payload.text : "";
      if (voiceAnchorRef.current === null) {
        voiceAnchorRef.current = inputRef.current.length;
      }
      const anchor = voiceAnchorRef.current;
      const prefix = inputRef.current.slice(0, anchor);
      const merged = prefix.length > 0 && text.length > 0 && !prefix.endsWith(" ")
        ? `${prefix} ${text}`
        : `${prefix}${text}`;
      setInput(merged);
      if (payload.type === "final") {
        // Final flush — keep anchor where it is so the user can keep talking
        // on the next start without losing the typed prefix; recognizer will
        // restart in continuous mode if listening is still true.
      }
    };
    (window as unknown as Record<string, unknown>)["__clawHqVoiceCallback"] = handler;
    return () => {
      if ((window as unknown as Record<string, unknown>)["__clawHqVoiceCallback"] === handler) {
        delete (window as unknown as Record<string, unknown>)["__clawHqVoiceCallback"];
      }
    };
  }, [voiceAvailable, chatId]);

  const toggleVoice = useCallback(() => {
    if (!voiceAvailable) return;
    const bridge = (window as unknown as {
      ClawHqVoiceBridge?: { start(): boolean; stop(): void };
    }).ClawHqVoiceBridge;
    if (!bridge) return;
    if (listening) {
      try { bridge.stop(); } catch (e) { console.warn("voice stop failed:", e); }
      setListening(false);
      voiceAnchorRef.current = null;
      return;
    }
    // Capture current cursor position so partials only replace the voice region.
    const ta = textareaRef.current;
    voiceAnchorRef.current = ta?.selectionStart ?? inputRef.current.length;
    try {
      const ok = bridge.start();
      if (ok) setListening(true);
      // If start returned false, it's awaiting a permission prompt; the
      // permission callback will retry.
    } catch (e) { console.warn("voice start failed:", e); }
  }, [voiceAvailable, listening]);

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
        const display: DisplayItem[] = [];
        for (const m of chat.messages) {
          if (m.role === "tool") {
            const payload = parsePersistedTool(m.content);
            if (payload) {
              const isError = payload.isError === true;
              display.push({
                kind: "tool",
                tool: {
                  toolCallId: payload.toolCallId,
                  name: payload.name,
                  args: payload.args,
                  result: payload.result,
                  isError,
                  status: isError ? "error" : "done",
                  startedMs: payload.startedMs ?? m.createdMs,
                  doneMs: payload.doneMs ?? m.createdMs,
                },
              });
              continue;
            }
            // Corrupt payload — surface as system row so we don't drop it.
            display.push({
              kind: "message",
              message: { id: m.id, role: "system", text: `[unparseable tool entry]` },
            });
            continue;
          }
          display.push({
            kind: "message",
            message: { id: m.id, role: m.role as "user" | "assistant" | "system", text: m.content },
          });
        }
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
        // AskUserQuestion is rendered as a tap-card, not a generic tool block.
        // Same OHQ pattern from src/app/chat/[id]/ChatView.tsx → block.kind === "ask-question".
        if (name === "AskUserQuestion") {
          const questions = parseAskQuestionArgs(args);
          if (questions) {
            setItems((prev) => {
              if (prev.some(
                (it) => (it.kind === "question" && it.question.toolCallId === toolCallId)
                  || (it.kind === "tool" && it.tool.toolCallId === toolCallId),
              )) return prev;
              return [
                ...prev,
                {
                  kind: "question",
                  question: { toolCallId, questions, status: "pending", startedMs: ts },
                },
              ];
            });
            return;
          }
        }
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
        // If the result corresponds to an AskUserQuestion card we already
        // rendered, mark that card as answered and skip the tool-block path +
        // tool-persistence path (cards are stateless on reload — see step 14's
        // approval-card design rationale).
        let questionHandled = false;
        setItems((prev) => {
          const qIdx = prev.findIndex(
            (it) => it.kind === "question" && it.question.toolCallId === toolCallId,
          );
          if (qIdx === -1) return prev;
          questionHandled = true;
          const existing = prev[qIdx]!;
          if (existing.kind !== "question") return prev;
          if (existing.question.status === "answered") return prev;
          const next = [...prev];
          next[qIdx] = {
            kind: "question",
            question: { ...existing.question, status: "answered" },
          };
          return next;
        });
        if (questionHandled) return;
        let persistedArgs: unknown = undefined;
        let persistedStartedMs = ts;
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
          persistedArgs = existing.tool.args;
          persistedStartedMs = existing.tool.startedMs;
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
        // Persist the completed tool call so a chat reload reconstructs it.
        const payload: PersistedToolPayload = {
          toolCallId,
          name,
          args: persistedArgs,
          result,
          isError,
          startedMs: persistedStartedMs,
          doneMs: ts,
        };
        void client
          .call<{ message?: { id?: string } }>("clawhq.chats.append", {
            chatId,
            role: "tool",
            content: JSON.stringify(payload),
          })
          .then((r) => { if (r?.message?.id) noteOwnPersist(r.message.id); })
          .catch((e) => { console.warn("clawhq.chats.append (tool) failed:", e); });
        return;
      }
    });
  }, [client, sessionKey, chatId, noteOwnPersist]);

  // Resolve an exec approval inline; mirrors ApprovalsPage but updates the in-chat
  // card status and persists a system row so reload reflects the decision.
  const resolveApproval = useCallback(
    async (approvalId: string, allow: boolean) => {
      // Snapshot the command label before we mutate so we can persist a useful
      // system row even if the card is removed on a future event.
      let commandLabel = approvalId;
      setItems((prev) => {
        const idx = prev.findIndex(
          (it) => it.kind === "approval" && it.approval.id === approvalId,
        );
        if (idx === -1) return prev;
        const target = prev[idx]!;
        if (target.kind !== "approval") return prev;
        if (target.approval.command) commandLabel = target.approval.command;
        const next = [...prev];
        next[idx] = {
          kind: "approval",
          approval: { ...target.approval, busy: true },
        };
        return next;
      });
      try {
        await client.call("exec.approval.resolve", { id: approvalId, allow });
        const decisionMs = Date.now();
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "approval" && it.approval.id === approvalId
              ? {
                  kind: "approval" as const,
                  approval: {
                    ...it.approval,
                    status: allow ? ("approved" as const) : ("denied" as const),
                    decisionMs,
                    busy: false,
                  },
                }
              : it,
          ),
        );
        // Persist a system row so reload reflects the outcome. We don't extend
        // the plugin's role union for this — the simpler path is a marker line.
        const verb = allow ? "approved" : "denied";
        const summary = commandLabel.length > 120
          ? `${commandLabel.slice(0, 117)}…`
          : commandLabel;
        void client
          .call<{ message?: { id?: string } }>("clawhq.chats.append", {
            chatId,
            role: "system",
            content: `approval ${verb}: ${summary}`,
          })
          .then((r) => { if (r?.message?.id) noteOwnPersist(r.message.id); })
          .catch((e) => { console.warn("clawhq.chats.append (approval) failed:", e); });
      } catch (e) {
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "approval" && it.approval.id === approvalId
              ? { kind: "approval" as const, approval: { ...it.approval, busy: false } }
              : it,
          ),
        );
        window.alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [client, chatId, noteOwnPersist],
  );

  // Exec approval events. The gateway broadcasts exec.approval.requested when a
  // command needs human go-ahead, and exec.approval.resolved when any operator
  // resolves it. We filter both by sessionKey so the card only lands in the chat
  // whose session it belongs to. Approvals fired outside any chat session
  // (CLI-only) are ignored here — the Approvals page handles those.
  useEffect(() => {
    return client.onEvent((ev: OpenClawEvent) => {
      if (ev.event !== "exec.approval.requested" && ev.event !== "exec.approval.resolved") {
        return;
      }
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      // Payload shape varies; the approval body might be top-level or nested
      // under .approval / .request. Read defensively.
      const body = ((p.approval ?? p.request ?? p) as Record<string, unknown>) || {};
      const id = typeof body.id === "string" ? body.id
        : typeof p.id === "string" ? p.id
        : null;
      if (!id) return;
      const evSessionKey =
        typeof body.sessionKey === "string" ? body.sessionKey
        : typeof p.sessionKey === "string" ? p.sessionKey
        : null;
      if (evSessionKey && evSessionKey !== sessionKey) return;
      // No sessionKey means we can't attribute it to this chat — skip.
      if (!evSessionKey) return;

      if (ev.event === "exec.approval.requested") {
        const command = typeof body.command === "string" ? body.command : undefined;
        const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
        const reason = typeof body.reason === "string" ? body.reason : undefined;
        const requestedMs =
          typeof body.requestedAt === "number" ? body.requestedAt
          : typeof p.ts === "number" ? p.ts
          : Date.now();
        setItems((prev) => {
          if (prev.some((it) => it.kind === "approval" && it.approval.id === id)) {
            return prev;
          }
          return [
            ...prev,
            {
              kind: "approval",
              approval: { id, command, cwd, reason, requestedMs, status: "pending" },
            },
          ];
        });
        return;
      }
      // exec.approval.resolved — could be us or another operator. If we're
      // showing a card for this id, mark it resolved.
      const decision = body.decision ?? body.allow ?? p.decision ?? p.allow;
      const allow =
        decision === true
        || decision === "approved"
        || decision === "allow"
        || decision === "allowed";
      const decisionMs =
        typeof body.resolvedAt === "number" ? body.resolvedAt
        : typeof p.ts === "number" ? p.ts
        : Date.now();
      setItems((prev) =>
        prev.map((it) =>
          it.kind === "approval" && it.approval.id === id && it.approval.status === "pending"
            ? {
                kind: "approval" as const,
                approval: {
                  ...it.approval,
                  status: allow ? ("approved" as const) : ("denied" as const),
                  decisionMs,
                  busy: false,
                },
              }
            : it,
        ),
      );
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
        if (msg.role === "tool") {
          const payload = parsePersistedTool(msg.content);
          if (!payload) return;
          const isError = payload.isError === true;
          setItems((prev) => {
            if (prev.some((it) => it.kind === "tool" && it.tool.toolCallId === payload.toolCallId)) {
              return prev;
            }
            return [
              ...prev,
              {
                kind: "tool",
                tool: {
                  toolCallId: payload.toolCallId,
                  name: payload.name,
                  args: payload.args,
                  result: payload.result,
                  isError,
                  status: isError ? "error" : "done",
                  startedMs: payload.startedMs ?? msg.createdMs,
                  doneMs: payload.doneMs ?? msg.createdMs,
                },
              },
            ];
          });
          return;
        }
        setItems((prev) => {
          if (prev.some((it) => it.kind === "message" && it.message.id === msg.id)) return prev;
          return [
            ...prev,
            {
              kind: "message" as const,
              message: { id: msg.id, role: msg.role as "user" | "assistant" | "system", text: msg.content },
            },
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
    // If voice was streaming partials when the user hit send, stop the
    // recognizer so it doesn't append the next utterance into the next chat.
    if (listening) {
      try {
        const bridge = (window as unknown as {
          ClawHqVoiceBridge?: { stop(): void };
        }).ClawHqVoiceBridge;
        bridge?.stop();
      } catch (e) { console.warn("voice stop on send failed:", e); }
      setListening(false);
      voiceAnchorRef.current = null;
    }
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
            data: await attachmentBytesBase64(a),
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
  }, [client, chatId, projectSlug, sessionKey, input, attachments, status.kind, pending, noteOwnPersist, revokePreviewUrl, listening]);

  // Answer an inline AskUserQuestion tap-card: send the label as a new user
  // turn (same as OHQ's onAnswer flow). Optimistic-flips the card to answered
  // immediately so a double-tap can't double-send.
  const answerQuestion = useCallback(
    async (toolCallId: string, label: string) => {
      if (status.kind !== "ready" || pending) return;
      let alreadyAnswered = false;
      setItems((prev) => {
        const idx = prev.findIndex(
          (it) => it.kind === "question" && it.question.toolCallId === toolCallId,
        );
        if (idx === -1) return prev;
        const target = prev[idx]!;
        if (target.kind !== "question") return prev;
        if (target.question.status === "answered") { alreadyAnswered = true; return prev; }
        const next = [...prev];
        next[idx] = {
          kind: "question",
          question: { ...target.question, status: "answered", answer: label },
        };
        return next;
      });
      if (alreadyAnswered) return;
      setPending(true);
      const optimistic: DisplayMessage = { id: newId(), role: "user", text: label };
      setItems((prev) => [...prev, { kind: "message", message: optimistic }]);
      try {
        const appendResult = await client.call<{ message?: { id?: string } }>(
          "clawhq.chats.append",
          { chatId, role: "user", content: label },
        );
        if (appendResult?.message?.id) noteOwnPersist(appendResult.message.id);
        await client.call("chat.send", {
          sessionKey,
          message: label,
          idempotencyKey: `clawhq-${chatId}-q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Flip the card back so the user can retry.
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "question" && it.question.toolCallId === toolCallId
              ? {
                  kind: "question" as const,
                  question: { ...it.question, status: "pending" as const, answer: undefined },
                }
              : it,
          ),
        );
        setErr(`Answer failed: ${msg}`);
        setPending(false);
      }
    },
    [client, chatId, sessionKey, status.kind, pending, noteOwnPersist],
  );

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

  // Thinking indicator: between Send and the first response activity (text
  // delta, tool start, approval, or question), show the three-dot pulse. Once
  // anything has been appended after the last user message, the agent is
  // visibly responding and the dots would be redundant.
  const showThinking = (() => {
    if (!pending || items.length === 0) return false;
    const last = items[items.length - 1];
    return last !== undefined && last.kind === "message" && last.message.role === "user";
  })();

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
          if (it.kind === "approval") {
            return (
              <ApprovalBlock
                key={itemKey(it)}
                approval={it.approval}
                onResolve={resolveApproval}
              />
            );
          }
          if (it.kind === "question") {
            return (
              <QuestionBlock
                key={itemKey(it)}
                question={it.question}
                onAnswer={answerQuestion}
                disabled={status.kind !== "ready" || pending}
              />
            );
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
              {m.streaming && <span className="streaming-caret" aria-hidden="true" />}
            </div>
          );
        })}
        {showThinking && (
          <div className="thinking-indicator" role="status" aria-label="agent thinking">
            <span /><span /><span />
          </div>
        )}
        {err && <div className="bubble system">{err}</div>}
        {dragOver && (
          <div className="drop-overlay">Drop to attach</div>
        )}
      </div>

      <div className="composer">
        {showHistoryPicker && (
          <div className="composer-history-picker">
            <div className="composer-history-picker-head">
              <strong>Re-attach from chat history</strong>
              <button
                type="button"
                className="composer-history-picker-close"
                aria-label="Close"
                onClick={() => setShowHistoryPicker(false)}
              >✕</button>
            </div>
            {historyAttachments.length === 0 ? (
              <div className="composer-history-picker-empty">
                No prior uploads in this chat yet.
              </div>
            ) : (
              <ul className="composer-history-picker-list">
                {historyAttachments.map((h) => {
                  const alreadyOn = activeUploadIds.has(h.uploadId);
                  return (
                    <li key={h.uploadId}>
                      <button
                        type="button"
                        className="composer-history-picker-row"
                        disabled={alreadyOn || status.kind !== "ready"}
                        onClick={() => void addHistoryAttachment(h)}
                      >
                        <img
                          src={h.url}
                          alt=""
                          className="composer-history-picker-thumb"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                        <span className="composer-history-picker-name" title={h.filename}>
                          {h.filename}
                        </span>
                        {alreadyOn && (
                          <span className="composer-history-picker-on">attached</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
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
          {voiceAvailable && (
            <button
              type="button"
              className={`composer-mic ${listening ? "listening" : ""}`}
              aria-label={listening ? "Stop voice input" : "Start voice input"}
              title={listening ? "Stop voice input" : "Voice input"}
              disabled={status.kind !== "ready" || pending}
              onClick={toggleVoice}
            >🎤</button>
          )}
          <button
            type="button"
            className="composer-attach"
            aria-label="Attach files"
            title="Attach files"
            disabled={status.kind !== "ready" || pending}
            onClick={() => fileInputRef.current?.click()}
          >＋</button>
          {historyAttachments.length > 0 && (
            <button
              type="button"
              className={`composer-attach composer-history-trigger ${showHistoryPicker ? "active" : ""}`}
              aria-label="Attach from history"
              title={`Re-attach (${historyAttachments.length} prior)`}
              disabled={status.kind !== "ready" || pending}
              onClick={() => setShowHistoryPicker((v) => !v)}
            >
              📋<span className="composer-history-trigger-badge">{historyAttachments.length}</span>
            </button>
          )}
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
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              // If the user is editing manually while listening, drop the
              // voice anchor so the next partial starts a fresh region after
              // the current cursor.
              if (listening) voiceAnchorRef.current = e.target.selectionStart;
              setInput(e.target.value);
            }}
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
  // Edit/Write/MultiEdit get rendered as a real diff instead of raw args JSON.
  const fileEdits = useMemo(
    () => parseFileEditArgs(tool.name, tool.args),
    [tool.name, tool.args],
  );
  return (
    <div className={`tool-block ${tool.status}`}>
      <button
        type="button"
        className="tool-block-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-block-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-block-icon">{fileEdits ? "📝" : "🔧"}</span>
        <span className="tool-block-name">{tool.name}</span>
        {subtitle && <span className="tool-block-subtitle">{subtitle}</span>}
        {fileEdits && <DiffHeaderStats edits={fileEdits} />}
        <span className={`status-pill ${statusClass}`}>
          <span className="status-dot" />
          {statusLabel}
        </span>
      </button>
      {open && (
        <div className="tool-block-body">
          {fileEdits ? (
            <DiffView edits={fileEdits} />
          ) : (
            argsText && (
              <>
                <div className="tool-block-label">args</div>
                <pre className="tool-block-pre">{argsText}</pre>
              </>
            )
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

function DiffHeaderStats({ edits }: { edits: ParsedFileEdit[] }) {
  const totals = useMemo(() => {
    let added = 0;
    let deleted = 0;
    for (const e of edits) {
      const s = statsFor(lineDiff(e.before, e.after));
      added += s.added;
      deleted += s.deleted;
    }
    return { added, deleted };
  }, [edits]);
  if (!totals.added && !totals.deleted) return null;
  return (
    <span className="tool-block-diffstat">
      {totals.added > 0 && <span className="diff-add">+{totals.added}</span>}
      {totals.deleted > 0 && <span className="diff-del">−{totals.deleted}</span>}
    </span>
  );
}

function DiffView({ edits }: { edits: ParsedFileEdit[] }) {
  return (
    <div className="diff-view">
      {edits.map((edit, i) => (
        <DiffFile key={i} edit={edit} index={edits.length > 1 ? i + 1 : undefined} />
      ))}
    </div>
  );
}

const DIFF_LINE_HARD_CAP = 4000;

function DiffFile({ edit, index }: { edit: ParsedFileEdit; index?: number }) {
  const { hunks, more } = useMemo(() => {
    const lines = lineDiff(edit.before, edit.after);
    const allHunks = toHunks(lines);
    const total = allHunks.reduce((acc, h) => acc + h.lines.length, 0);
    if (total <= DIFF_LINE_HARD_CAP) return { hunks: allHunks, more: 0 };
    // Trim from the bottom to keep the head readable; surface the cut count.
    let kept = 0;
    const trimmed: DiffHunk[] = [];
    for (const h of allHunks) {
      if (kept + h.lines.length <= DIFF_LINE_HARD_CAP) {
        trimmed.push(h);
        kept += h.lines.length;
      } else {
        const room = DIFF_LINE_HARD_CAP - kept;
        if (room > 0) trimmed.push({ header: h.header, lines: h.lines.slice(0, room) });
        break;
      }
    }
    return { hunks: trimmed, more: total - kept };
  }, [edit]);
  const stats = useMemo(() => {
    let added = 0;
    let deleted = 0;
    for (const h of hunks) {
      for (const l of h.lines) {
        if (l.kind === "add") added++;
        else if (l.kind === "del") deleted++;
      }
    }
    return { added, deleted };
  }, [hunks]);
  return (
    <div className="diff-file">
      <div className="diff-file-header">
        <span className="diff-file-path">
          {index ? <span className="diff-file-index">#{index}</span> : null}
          {edit.filePath}
        </span>
        {edit.mode === "new-file" && <span className="diff-file-tag">new file</span>}
        <span className="diff-file-stats">
          {stats.added > 0 && <span className="diff-add">+{stats.added}</span>}
          {stats.deleted > 0 && <span className="diff-del">−{stats.deleted}</span>}
        </span>
      </div>
      <div className="diff-file-body">
        {hunks.length === 0 ? (
          <div className="diff-empty">no changes</div>
        ) : (
          hunks.map((h, i) => (
            <div key={i} className="diff-hunk">
              <div className="diff-hunk-header">{h.header}</div>
              {h.lines.map((l, j) => {
                const cls =
                  l.kind === "add" ? "add" : l.kind === "del" ? "del" : "ctx";
                const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
                return (
                  <div key={j} className={`diff-line ${cls}`}>
                    <span className="diff-line-num old">{l.oldNumber ?? ""}</span>
                    <span className="diff-line-num new">{l.newNumber ?? ""}</span>
                    <span className="diff-line-sign">{sign}</span>
                    <span className="diff-line-text">{l.text || " "}</span>
                  </div>
                );
              })}
            </div>
          ))
        )}
        {more > 0 && <div className="diff-more">… {more} more lines truncated</div>}
      </div>
    </div>
  );
}

function QuestionBlock({
  question,
  onAnswer,
  disabled,
}: {
  question: DisplayQuestion;
  onAnswer(toolCallId: string, label: string): void;
  disabled: boolean;
}) {
  const answered = question.status === "answered";
  return (
    <div className={`question-block ${answered ? "answered" : "pending"}`}>
      {question.questions.map((q, qi) => (
        <div key={qi} className="question-block-card">
          {q.header && <div className="question-block-header">{q.header}</div>}
          <div className="question-block-question">{q.question}</div>
          <div className="question-block-options">
            {q.options.map((opt, oi) => {
              const isChosen = answered && question.answer === opt.label;
              return (
                <button
                  key={oi}
                  type="button"
                  className={`question-block-option ${isChosen ? "chosen" : ""}`}
                  disabled={disabled || answered}
                  onClick={() => onAnswer(question.toolCallId, opt.label)}
                >
                  <div className="question-block-option-label">{opt.label}</div>
                  {opt.description && (
                    <div className="question-block-option-desc">{opt.description}</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {answered && question.answer && (
        <div className="question-block-answered-tag">answered: {question.answer}</div>
      )}
    </div>
  );
}

function ApprovalBlock({
  approval,
  onResolve,
}: {
  approval: DisplayApproval;
  onResolve(id: string, allow: boolean): void;
}) {
  const isPending = approval.status === "pending";
  const statusClass =
    approval.status === "approved" ? "ok"
    : approval.status === "denied" ? "bad"
    : "warn";
  const statusLabel =
    approval.status === "approved" ? "approved"
    : approval.status === "denied" ? "denied"
    : "needs approval";
  const command = approval.command ?? approval.id;
  return (
    <div className={`approval-block ${approval.status}`}>
      <div className="approval-block-header">
        <span className="approval-block-icon">✋</span>
        <span className="approval-block-title">Exec approval</span>
        <span className={`status-pill ${statusClass}`}>
          <span className="status-dot" />
          {statusLabel}
        </span>
      </div>
      <pre className="approval-block-cmd">{command}</pre>
      {approval.cwd && (
        <div className="approval-block-meta">
          cwd: <code>{approval.cwd}</code>
        </div>
      )}
      {approval.reason && (
        <div className="approval-block-meta">{approval.reason}</div>
      )}
      {isPending ? (
        <div className="approval-block-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={approval.busy}
            onClick={() => onResolve(approval.id, true)}
          >Approve</button>
          <button
            type="button"
            className="btn-ghost danger"
            disabled={approval.busy}
            onClick={() => onResolve(approval.id, false)}
          >Deny</button>
        </div>
      ) : null}
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

// Image extensions BubbleContent treats as renderable inline. Sourced from the
// URL path (server-computed) so the model can't trick us into rendering a
// non-image with a misleading filename.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif)(?:$|\?)/i;

function isInlineImageUrl(url: string): boolean {
  if (!url.startsWith("/uploads/")) return false;
  return IMAGE_EXT_RE.test(url);
}

/**
 * Render bubble text with `[label](url)` links turned into clickable anchors so
 * attachment refs show up properly. For `/uploads/<id>.<imageExt>` links we
 * also render an inline thumbnail above the link so the chat shows what was
 * actually sent after a reload. Optionally highlights case-insensitive matches
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
      {parts.map((p, i) => {
        if (p.kind !== "link") {
          return <span key={i}>{highlightText(p.text, highlight)}</span>;
        }
        const url = p.url ?? "";
        const isImage = isInlineImageUrl(url);
        return (
          <span key={i} className={isImage ? "bubble-link-image-wrap" : undefined}>
            {isImage && (
              <a href={url} target="_blank" rel="noopener noreferrer" className="bubble-image-link">
                <img
                  src={url}
                  alt={p.text}
                  className="bubble-image-thumb"
                  loading="lazy"
                  onError={(e) => {
                    // Hide if the upload was deleted or content isn't actually an image.
                    e.currentTarget.style.display = "none";
                  }}
                />
              </a>
            )}
            <a href={url} target="_blank" rel="noopener noreferrer" className="bubble-link">
              {highlightText(p.text, highlight)}
            </a>
          </span>
        );
      })}
    </>
  );
}
