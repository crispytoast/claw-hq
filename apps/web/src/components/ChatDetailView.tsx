import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";
import { sessionScopePrefix, type ChatKind } from "./ChatApp.js";
import { lineDiff, parseFileEditArgs, statsFor, toHunks } from "./diff.js";
import type { DiffHunk, ParsedFileEdit } from "./diff.js";
import { extractHistoryAttachments, type HistoryAttachment } from "./history-attachments.js";
import {
  Plus, Mic, Clipboard, Image, X, Chevron, Hourglass, Chat, ArrowUp,
  Tools, Pencil, Hand, Clip,
} from "./icons.js";

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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

async function attachmentBytesBase64(a: UploadedAttachment): Promise<string> {
  if (a.source.kind === "file") {
    return blobToBase64(a.source.file);
  }
  const res = await fetch(a.source.url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`re-fetch upload failed: ${res.status}`);
  return blobToBase64(await res.blob());
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
  /** Scope of this chat (Phase 8.1). undefined = legacy "project" semantics. */
  chatKind?: ChatKind;
  status: ConnectionStatus;
  /** Per-chat run status from the parent (ChatApp). Drives the persistent
   * thinking indicator — stays on across chat switches/screen off as long
   * as the agent is still running. undefined = unknown / not running. */
  chatStatus?: "running" | "done";
  onTitleChange?(chatId: string, title: string): void;
  /**
   * If set, render `<mark>` highlights around case-insensitive matches in every
   * message bubble + auto-scroll to the first match once items have loaded.
   * Threaded through from the sidebar search → ChatApp → here.
   */
  initialSearchQuery?: string;
  /** Set the sidebar status dot for this chat. Orange (running) on send;
   * ChatApp's global listener flips to green on state==="final". */
  onChatStatus?(chatId: string, status: "running" | "done"): void;
  /** Archive the current chat and route the user to a fresh chat for the
   *  same project. Implemented by ChatApp so it owns the recentChats list
   *  + activeChatId. The view only renders the banner + button. */
  onArchiveAndStartFresh?(chatId: string): void;
}

/** Soft-warn threshold for the large-chat banner. The Claude CLI's per-
 *  turn output cap (root cause of yesterday's 15K-msg failure AND the
 *  screenshot-heavy turn failure that hit overnight) isn't actually
 *  proportional to chat length — it's proportional to TURN output size,
 *  which depends on what the agent does in a turn, not how big the
 *  history is. So this threshold is just an "fyi this chat is getting
 *  long, maybe start fresh" hint, not a load-bearing defense. 1000 is
 *  a reasonable yellow flag without being annoying. Tune per taste. */
const LARGE_CHAT_BANNER_THRESHOLD = 3000;

/** localStorage key prefix for per-chat banner dismissal. Suffixed with
 *  the chatId so each chat dismisses independently. Durable across
 *  reloads — the banner is informational, not load-bearing, and the
 *  Reset button addresses the actual agent-stall concern. */
const LARGE_CHAT_BANNER_DISMISS_KEY = "clawhq.chat.largeBanner.dismissed.";

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
  /** Wall-clock when the message was created/persisted. Drives the
   * timestamp shown under each bubble. May be undefined while a message
   * is mid-stream — we stamp at final. */
  createdMs?: number;
  /** OHQ-style HUD footer pinned to the bottom of assistant bubbles:
   *  token count, cost, context %. Set at chat-final and on history load
   *  (when a persisted HUD system row follows the assistant). */
  hud?: { body: string; ctxPct: number | null };
}

interface ModelEntry {
  id: string;
  provider?: string;
  label?: string;
  isDefault?: boolean;
}
interface ModelsListResp {
  models?: ModelEntry[];
  entries?: ModelEntry[];
}
interface SessionRowMin {
  sessionKey?: string;
  key?: string;
  model?: string;
  resolvedModel?: string;
}
interface SessionsListResp {
  sessions?: SessionRowMin[];
  rows?: SessionRowMin[];
  items?: SessionRowMin[];
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

export function contentToText(content: unknown): string {
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

/**
 * Render the timestamp lane under each bubble. Same-day messages show
 * HH:MM; older messages also tag the day so a long-running chat is
 * scannable without hover-tooltips.
 */
function formatBubbleTimestamp(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = d.getHours();
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ampm = hh < 12 ? "AM" : "PM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const time = `${h12}:${mm} ${ampm}`;
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${time}`;
}

function sessionKeyFor(
  chatId: string,
  scope: { kind?: ChatKind; projectSlug?: string | null },
): string {
  // Deterministic per-chat OpenClaw session so reloads continue the same context
  // when the underlying session is still warm on the agent. Scope prefix
  // (oswald/pmhq/clawhq) is centralized in sessionScopePrefix() — see
  // ChatApp.tsx where the relay's session regex is matched.
  return `agent:main:${sessionScopePrefix(scope)}-${chatId.slice(0, 8)}`;
}

// Parse a HUD-shaped system row (matches OHQ's `done · 6→748 tok · $0.0986 · ctx 72.0%`).
// Returns null for non-HUD system rows (errors, approval markers, etc) so they fall
// through to the plain centered render.
function parseHud(text: string): { body: string; ctxPct: number | null } | null {
  const t = text.trim();
  if (!/^(?:[—-]\s*)?(done|error|stopped)\b/i.test(t)) return null;
  const ctxMatch = t.match(/\bctx\s+(\d+(?:\.\d+)?)\s*%/i);
  const ctxPct = ctxMatch ? Number(ctxMatch[1]) : null;
  // Strip ctx tail from the body so it doesn't double-render.
  let body = t.replace(/\s*·?\s*ctx\s+\d+(?:\.\d+)?\s*%\s*$/i, "").trim();
  body = body.replace(/^[—-]\s*/, "").replace(/\s*—\s*$/, "").trim();
  return { body, ctxPct };
}

// Defensive extraction of usage + cost from the chat event final payload.
// OpenClaw's wrapper shape isn't typed in protocol-types; try the common
// places (Anthropic SDK shape via message.usage, OHQ's top-level total_cost_usd,
// camelCase variants the gateway might surface).
interface PickedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}
function pickUsage(p: Record<string, unknown>, m: Record<string, unknown> | null): PickedUsage | null {
  const candidates: unknown[] = [
    p.usage, p.finalUsage,
    m?.usage,
    (p.result as Record<string, unknown> | undefined)?.usage,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const num = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : undefined);
    const got: PickedUsage = {
      inputTokens: num("inputTokens") ?? num("input_tokens"),
      outputTokens: num("outputTokens") ?? num("output_tokens"),
      cacheReadTokens: num("cacheReadInputTokens") ?? num("cache_read_input_tokens"),
      cacheCreationTokens: num("cacheCreationInputTokens") ?? num("cache_creation_input_tokens"),
    };
    if (got.inputTokens !== undefined || got.outputTokens !== undefined) return got;
  }
  return null;
}
function pickCostUsd(p: Record<string, unknown>): number | null {
  const candidates: unknown[] = [
    p.totalCostUsd, p.total_cost_usd, p.costUsd, p.cost,
    (p.result as Record<string, unknown> | undefined)?.totalCostUsd,
    (p.result as Record<string, unknown> | undefined)?.total_cost_usd,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && c >= 0) return c;
  }
  return null;
}
const CONTEXT_LIMIT = 200_000;

/**
 * Pull usage from a session row and attach a HUD to the given bubble.
 *
 * Returns true if the row had usable usage data and a HUD was attached,
 * false if the row was empty/stale and we should try again later.
 *
 * Dedup: pass `attachedBubbleIds` so we don't double-attach when both the
 * event path and the poll fallback see the same row. First caller wins.
 */
function tryAttachHudFromRow(args: {
  row: Record<string, unknown>;
  client: GatewayClient;
  chatId: string;
  bubbleId: string;
  setItems: React.Dispatch<React.SetStateAction<DisplayItem[]>>;
  noteOwnPersist: (id: string) => void;
  attachedBubbleIds: Set<string>;
}): boolean {
  if (args.attachedBubbleIds.has(args.bubbleId)) return true;
  const num = (k: string): number | null => {
    const v = args.row[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  // OpenClaw's row semantics (verified live):
  //   inputTokens / outputTokens — THIS turn only (per-call)
  //   totalTokens — cumulative session usage so far
  //   contextTokens — MODEL'S context window capacity (e.g. 1,048,576 for
  //                   Opus 4.7's 1M window), NOT current usage.
  const inputTokens = num("inputTokens");
  const outputTokens = num("outputTokens");
  const totalTokens = num("totalTokens");
  const contextWindow = num("contextTokens");
  const costUsd = num("estimatedCostUsd") ?? num("totalCostUsd");
  if (inputTokens === null && outputTokens === null && costUsd === null && totalTokens === null) {
    return false;
  }
  const tokensPart = (inputTokens !== null || outputTokens !== null)
    ? ` · ${inputTokens ?? 0}→${outputTokens ?? 0} tok`
    : "";
  const costPart = costUsd !== null ? ` · $${costUsd.toFixed(4)}` : "";
  const body = `done${tokensPart}${costPart}`;
  const ctxPct = totalTokens !== null && totalTokens > 0
    && contextWindow !== null && contextWindow > 0
    ? Math.min(999, (totalTokens / contextWindow) * 100)
    : null;
  // Mark first so a concurrent caller bails. CAS-flavored — Set.has check
  // was already done at top of function, but we still race on the write.
  args.attachedBubbleIds.add(args.bubbleId);
  const hud = { body, ctxPct };
  args.setItems((prev) => prev.map((it) =>
    it.kind === "message" && it.message.id === args.bubbleId
      ? { kind: "message" as const, message: { ...it.message, hud } }
      : it,
  ));
  const hudText = ctxPct !== null ? `${body} · ctx ${ctxPct.toFixed(1)}%` : body;
  void args.client
    .call<{ message?: { id?: string } }>("clawhq.chats.append", {
      chatId: args.chatId,
      role: "system",
      content: hudText,
    })
    .then((r) => {
      if (r?.message?.id) args.noteOwnPersist(r.message.id);
    })
    .catch((e) => {
      console.warn("clawhq.chats.append (hud) failed:", e);
    });
  return true;
}

/**
 * Fetch our session row from sessions.list and attempt a HUD attach.
 * Used by both the event-driven path (sessions.changed listener) and
 * the poll fallback.
 */
async function fetchRowAndAttempt(args: {
  client: GatewayClient;
  chatId: string;
  sessionKey: string;
  bubbleId: string;
  setItems: React.Dispatch<React.SetStateAction<DisplayItem[]>>;
  noteOwnPersist: (id: string) => void;
  attachedBubbleIds: Set<string>;
}): Promise<boolean> {
  let row: Record<string, unknown> | null = null;
  try {
    const result = await args.client.call<{ sessions?: Array<Record<string, unknown>> }>(
      "sessions.list",
      {},
    );
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    for (const s of sessions) {
      if ((s as { key?: string }).key === args.sessionKey) {
        row = s;
        break;
      }
    }
  } catch (e) {
    console.warn("sessions.list (hud) failed:", e);
    return false;
  }
  if (!row) return false;
  return tryAttachHudFromRow({
    row,
    client: args.client,
    chatId: args.chatId,
    bubbleId: args.bubbleId,
    setItems: args.setItems,
    noteOwnPersist: args.noteOwnPersist,
    attachedBubbleIds: args.attachedBubbleIds,
  });
}

/**
 * Poll fallback. The sessions.changed event listener is the primary signal,
 * but if it never fires (e.g., gateway buffered the update past our listener
 * lifecycle), this guarantees the HUD eventually lands. Extended window —
 * ~20s total — to cover slow turns where the gateway lags on writing the
 * post-turn usage to the session row.
 */
async function fetchAndAttachHud(args: {
  client: GatewayClient;
  chatId: string;
  sessionKey: string;
  bubbleId: string;
  setItems: React.Dispatch<React.SetStateAction<DisplayItem[]>>;
  noteOwnPersist: (id: string) => void;
  attachedBubbleIds: Set<string>;
}): Promise<void> {
  const delays = [200, 400, 800, 1200, 1600, 2000, 2500, 3000, 4000, 5000];
  for (const ms of delays) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (args.attachedBubbleIds.has(args.bubbleId)) return;
    const attached = await fetchRowAndAttempt(args);
    if (attached) return;
  }
}
function formatTurnHud(p: Record<string, unknown>, m: Record<string, unknown> | null): { text: string; ctxPct: number | null } | null {
  const usage = pickUsage(p, m);
  const cost = pickCostUsd(p);
  if (!usage && cost === null) return null;
  const tokens = usage
    ? ` · ${usage.inputTokens ?? 0}→${usage.outputTokens ?? 0} tok`
    : "";
  const costStr = cost !== null ? ` · $${cost.toFixed(4)}` : "";
  const ctxNumer = usage
    ? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
    : 0;
  const ctxPct = ctxNumer > 0 ? Math.min(999, (ctxNumer / CONTEXT_LIMIT) * 100) : null;
  return { text: `done${tokens}${costStr}`, ctxPct };
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

export function ChatDetailView({ client, chatId, projectSlug, chatKind, status, chatStatus, onTitleChange, initialSearchQuery, onChatStatus, onArchiveAndStartFresh }: Props) {
  const [items, setItems] = useState<DisplayItem[]>([]);
  /**
   * How many items off the bottom we actually render. Huge chats (PM HQ at
   * 14k+ messages) blow render budgets and lag every keystroke when the
   * full list goes through React reconciliation on each input change.
   * Default 100 keeps the recent context visible while collapsing the
   * older 14,765 into a single "Show earlier" button at the top.
   */
  const [visibleCount, setVisibleCount] = useState(100);
  const [chatTitle, setChatTitle] = useState<string>("");
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  // Set true when the watchdog ships canCompact:true on a chat:error frame.
  // Surfaces the "Compact & resume" CTA above the composer. Cleared on
  // successful sessions.compact + on any subsequent successful run.
  const [stallCompactAvailable, setStallCompactAvailable] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [resettingSession, setResettingSession] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** runId -> id of the streaming assistant bubble */
  const streamMapRef = useRef<Map<string, string>>(new Map());
  /** runId -> HUD that arrived on agent-end before the chat-final bubble existed. */
  const pendingHudRef = useRef<Map<string, { body: string; ctxPct: number | null }>>(new Map());
  /** BubbleIds that already have a HUD attached. Dedup across event-driven
   *  and poll-fallback HUD paths so neither can double-attach. */
  const hudAttachedBubbleIdsRef = useRef<Set<string>>(new Set());
  /** Bubble currently awaiting its HUD attach. Set on chat-final, cleared
   *  on successful attach. Used by the sessions.changed listener to know
   *  which bubble to target without threading runId through events. */
  const awaitingHudBubbleIdRef = useRef<string | null>(null);
  /** Set after we successfully append a memory preamble, so we don't re-inject. */
  const memoryInjectedRef = useRef(false);
  /** Message ids we just persisted via clawhq.chats.append; lets us drop our own broadcast echo. */
  const recentlyPersistedIdsRef = useRef<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploading, setUploading] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  /** Layout for the clipboard re-attach picker: row list (default), 4-up
   *  grid of small cards, or 1-up wide preview cards. */
  const [historyViewMode, setHistoryViewMode] = useState<"list" | "grid4" | "grid1">("list");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionKey = useMemo(
    () => sessionKeyFor(chatId, { kind: chatKind, projectSlug }),
    [chatId, chatKind, projectSlug],
  );

  // Multi-viewer subscription. Mounting this view declares we want to see
  // agent-to-client event frames for sessionKey even if this client wasn't
  // the run's originator. Peer copies arrive tagged viewerRole="peer" so
  // the event handlers below can render them without re-persisting to chat
  // storage (server-side relay owns the authoritative writes for assistant
  // turns; originator-driven persists handle tool/approval).
  useEffect(() => {
    client.watchSession(sessionKey);
    return () => client.unwatchSession(sessionKey);
  }, [client, sessionKey]);

  // Large-chat banner: dismissal is per-chat AND durable across reloads
  // (localStorage-keyed by chatId). The banner is informational — the
  // Reset button addresses the actual agent-stall concern, so once the
  // user has acknowledged once we don't keep nagging.
  const [largeChatDismissed, setLargeChatDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(LARGE_CHAT_BANNER_DISMISS_KEY + chatId) === "1";
    } catch {
      return false;
    }
  });
  const dismissLargeChatBanner = useCallback(() => {
    setLargeChatDismissed(true);
    try {
      window.localStorage.setItem(LARGE_CHAT_BANNER_DISMISS_KEY + chatId, "1");
    } catch {
      /* private mode / quota — banner just re-shows on reload */
    }
  }, [chatId]);

  // Terminal-panel visibility on desktop. On mobile the panel is reachable
  // by horizontal swipe (the chat-swipe-wrap snap container); on desktop
  // it's hidden by default and toggled by the </> button in the title bar.
  // Persisted per-browser via localStorage so the toggle sticks across
  // reloads. Doesn't affect mobile — the swipe-wrap CSS always shows it
  // there. Keyed globally (not per-chat) since the preference is a
  // workspace-level layout choice.
  const TERMINAL_TOGGLE_KEY = "clawhq.chat.terminal.visible";
  const [showTerminal, setShowTerminal] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(TERMINAL_TOGGLE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleTerminal = useCallback(() => {
    setShowTerminal((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(TERMINAL_TOGGLE_KEY, next ? "1" : "0");
      } catch {
        /* private mode / quota — toggle won't survive reload */
      }
      return next;
    });
  }, []);

  // Inline rename of the chat title from the header. Click the title to edit;
  // Enter or blur commits, Escape cancels. Calls clawhq.chats.rename and
  // relies on the existing plugin.clawhq.chat.renamed broadcast (handled
  // below) to propagate to the sidebar.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const startEditTitle = useCallback(() => {
    setTitleDraft(chatTitle);
    setEditingTitle(true);
  }, [chatTitle]);
  const cancelTitleEdit = useCallback(() => {
    setEditingTitle(false);
  }, []);
  const commitTitleEdit = useCallback(async () => {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === chatTitle) return;
    setChatTitle(next); // optimistic; broadcast will re-apply idempotently
    try {
      await client.call("clawhq.chats.rename", { chatId, title: next });
    } catch (e) {
      console.warn("clawhq.chats.rename failed:", e);
    }
  }, [client, chatId, chatTitle, titleDraft]);

  const resetSession = useCallback(async () => {
    if (resettingSession) return;
    if (!window.confirm(
      "Reset agent session for this chat? History stays visible; " +
      "the agent will forget everything above the divider.",
    )) return;
    setResettingSession(true);
    try {
      const res = await client.call<{ mode?: "gateway" | "fast" }>(
        "clawhq.chats.resetSession",
        { chatId },
      );
      if ((res?.mode ?? "gateway") === "gateway") {
        try {
          await client.call("sessions.reset", { sessionKey });
        } catch (e) {
          console.warn("sessions.reset failed (likely no session yet):", e);
        }
      }
      // Re-enable memory preamble re-injection on next turn so the agent
      // starts fresh with full project context.
      memoryInjectedRef.current = false;
      // Reset solves the agent-stall concern the banner warns about —
      // dismiss it durably for this chat.
      dismissLargeChatBanner();
      // Plugin broadcast (plugin.clawhq.chat.message) handles appending
      // the divider via the existing chat-message listener.
    } catch (e) {
      setErr(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResettingSession(false);
    }
  }, [chatId, client, sessionKey, resettingSession, dismissLargeChatBanner]);
  /** Currently-active model for this chat's session. Null = gateway default. */
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelEntry[] | null>(null);
  const [modelMenuErr, setModelMenuErr] = useState<string | null>(null);
  const [modelPatching, setModelPatching] = useState(false);

  // Phone-width detection drives the swipe-to-terminal pattern: on mobile the
  // chat surface becomes a horizontal snap container, tool blocks shift out of
  // the message list into the terminal pane (same as OHQ).
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 720px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

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

  // Auto-resize the composer textarea to fit its content. CSS caps the
  // visible height (max-height: 12.5rem = 200px); beyond that the textarea
  // becomes internally scrollable. Runs on every input change including
  // programmatic ones (voice partials, paste, history attach).
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

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
    setVisibleCount(100);
    setErr("");
    memoryInjectedRef.current = false;
    streamMapRef.current.clear();
    pendingHudRef.current.clear();
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
          // If this is a persisted HUD system row, fold it into the
          // immediately preceding assistant bubble instead of rendering as
          // its own line — OHQ-style footer.
          if (m.role === "system") {
            const parsed = parseHud(m.content);
            const tail = display[display.length - 1];
            if (parsed && tail?.kind === "message" && tail.message.role === "assistant") {
              const updated: DisplayMessage = {
                ...tail.message,
                hud: { body: parsed.body, ctxPct: parsed.ctxPct },
              };
              display[display.length - 1] = { kind: "message", message: updated };
              continue;
            }
          }
          display.push({
            kind: "message",
            message: {
              id: m.id,
              role: m.role as "user" | "assistant" | "system",
              text: m.content,
              createdMs: m.createdMs,
            },
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
        if (!cancelled) {
          setLoading(false);
          // Any in-flight turn from before this mount has either already
          // finalized server-side (we just loaded its assistant reply from
          // history) or its `state:"final"` event fired while we were
          // disconnected and was missed. Either way, the local "thinking"
          // flag from the prior session is stale — clear it. Streaming
          // events still in flight will keep updating the assistant bubble.
          setPending(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, chatId, status.kind]);

  // Pending-stuck watchdog. A healthy turn clears `pending` on the agent's
  // `final` event (line ~1187/1220). If the run dies silently — gateway
  // restart, tunnel drop mid-turn, agent crash — pending sticks forever and
  // every subsequent send silently no-ops at the gate up top. After 120 s
  // with no final, we clear pending so the user can send again and add a
  // system bubble so they know what happened.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      setPending(false);
      setItems((prev) => [
        ...prev,
        {
          kind: "message",
          message: {
            id: newId(),
            role: "system",
            text: "Previous turn appears stuck (no response in 2 min). You can try again, or tap Reset above to clear the agent session.",
          },
        },
      ]);
    }, 120_000);
    return () => clearTimeout(timer);
  }, [pending]);

  // Reconcile running flag with upstream truth on every (re)connect. The
  // indicator should reflect the live run state, so we re-poll sessions.list
  // whenever the gateway flips to ready — not just once on mount. Two cases:
  //   1. After page reload / SPA cold start: chatStatus is undefined; if the
  //      upstream session has an active run, hoist "running" up so the dots
  //      turn on without waiting for the next delta.
  //   2. After a tunnel drop where chatStatus was "running" and the final
  //      event fired during disconnect: sessions.list will report no active
  //      run, so we flip to "done" and the dots stop. Without this the dots
  //      would dance forever after any missed final.
  useEffect(() => {
    if (status.kind !== "ready") return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.call<{ sessions?: Array<{ key?: string; hasActiveRun?: boolean }> }>(
          "sessions.list",
          {},
        );
        if (cancelled) return;
        const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
        const hit = sessions.find((s) => s.key === sessionKey);
        const active = !!hit?.hasActiveRun;
        if (active && chatStatus !== "running") {
          onChatStatus?.(chatId, "running");
        } else if (!active && chatStatus === "running") {
          onChatStatus?.(chatId, "done");
        }
      } catch (e) {
        console.warn("sessions.list (running-status reconcile) failed:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [client, sessionKey, chatId, chatStatus, status.kind, onChatStatus]);

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

      // Failure path: OpenClaw emits state="error" (with optional
      // errorMessage) or state="aborted" when a run dies before producing
      // a reply. No `message` ships, so the role check below would early-
      // return; instead, synthesize a `⚠️` bubble, drop the streaming
      // dots, and tell the parent the chat is no longer running. The relay
      // also persists the same synthetic message to chats-storage, so on
      // a cold reload the bubble is already there.
      if (state === "error" || state === "aborted") {
        const errMsg = typeof p.errorMessage === "string" ? p.errorMessage.trim() : "";
        const reason = errMsg || (state === "aborted" ? "Run aborted before completing." : "Unknown error.");
        const header = state === "aborted" ? "⚠️ Run stopped" : "⚠️ Run failed";
        // Stall failure path: watchdog ships canCompact=true so the user
        // can one-tap clear the buffer before retrying. Surface the CTA
        // below the bubble instead of pushing the user to "start a fresh
        // chat" — compaction is faster and keeps the chat alive.
        const canCompact = p.canCompact === true;
        if (canCompact) setStallCompactAvailable(true);
        // Match the error message to the most plausible cause and tailor
        // the guidance accordingly. The Claude CLI's per-turn output cap
        // looks like "Claude CLI turn output exceeded limit" — that one
        // is NOT about chat history length, it's about tool results
        // (often big base64 like screenshots) blowing the per-turn
        // stream-json budget. Generic "history may be too large" is
        // actively misleading there.
        const lowReason = reason.toLowerCase();
        const isTurnOutputCap = lowReason.includes("turn output") && lowReason.includes("exceed");
        let tail: string;
        if (canCompact) {
          tail = "_(The agent stalled — its session buffer probably overflowed. Tap **Compact & resume** below to clear it, then try again.)_";
        } else if (isTurnOutputCap) {
          tail = "_(This is the Claude CLI's per-turn output cap, not a chat-length issue. It triggers when a single turn produces too much output — most often a tool result returning a big base64 blob like a screenshot. The chat itself is fine; you can keep using it. The fix is on the agent side (have it save screenshots to disk and reference by path instead of reading the bytes back in-turn).)_";
        } else {
          tail = "_(The agent didn't produce a reply. If this keeps happening with the same chat, the conversation history may be too large — start a fresh chat.)_";
        }
        const body = `${header}\n\n${reason}\n\n${tail}`;
        setItems((prev) => {
          const bubbleId = runId ? streamMapRef.current.get(runId) : undefined;
          if (bubbleId) {
            return prev.map((it) =>
              it.kind === "message" && it.message.id === bubbleId
                ? { kind: "message" as const, message: { ...it.message, text: body, streaming: false, createdMs: Date.now() } }
                : it,
            );
          }
          return [
            ...prev,
            {
              kind: "message" as const,
              message: { id: newId(), role: "assistant", text: body, streaming: false, createdMs: Date.now() },
            },
          ];
        });
        setPending(false);
        if (chatStatus === "running") {
          onChatStatus?.(chatId, "done");
        }
        if (runId) {
          setTimeout(() => streamMapRef.current.delete(runId), 1000);
        }
        return;
      }

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
        // Any successful turn implies the buffer's recovered — clear the stall CTA.
        setStallCompactAvailable(false);
        // Stamp the final bubble with createdMs.
        setItems((prev) => prev.map((it) =>
          it.kind === "message" && runId && it.message.id === streamMapRef.current.get(runId)
            ? { kind: "message" as const, message: { ...it.message, createdMs: Date.now() } }
            : it,
        ));
        // Usage / cost / context aren't on any chat event — they sit on the
        // session row which OpenClaw patches mid-turn but doesn't emit a
        // dedicated "tokens updated" event for. The `sessions.changed("send")`
        // path lags by one turn (it fires when the NEXT turn starts).
        // Workaround: poll sessions.list shortly after chat-final, find our
        // session row, attach the HUD to this exact bubble (runId-mapped).
        //
        // Peers skip — only the originator persists the HUD as a system row;
        // peers receive it via the plugin.clawhq.chat.message broadcast and
        // render it as a system bubble below (no inline attach). Acceptable
        // v1 trade-off vs. having every viewer write a duplicate HUD row.
        const turnBubbleId = runId ? streamMapRef.current.get(runId) : null;
        if (turnBubbleId && ev.viewerRole !== "peer") {
          awaitingHudBubbleIdRef.current = turnBubbleId;
          void fetchAndAttachHud({
            client,
            chatId,
            sessionKey,
            bubbleId: turnBubbleId,
            setItems,
            noteOwnPersist,
            attachedBubbleIds: hudAttachedBubbleIdsRef.current,
          });
        }
        // Assistant-final persist is now handled by ChatApp's global
        // chat-event listener so it survives the user navigating to another
        // chat mid-response. See ChatApp.tsx — the listener calls
        // clawhq.chats.append for every clawhq-pattern session-key, not
        // just the one currently mounted.
        // HUD persistence still moved to the `agent` lifecycle-end listener
        // below (that's where usage / cost / context tokens actually arrive).
        if (runId) {
          setTimeout(() => streamMapRef.current.delete(runId), 1000);
        }
      }
    });
  }, [client, sessionKey, chatId, noteOwnPersist]);

  // Primary HUD signal: subscribe to sessions.changed events for our
  // sessionKey. The gateway emits one when it writes per-turn usage to
  // the session row (verified in OpenClaw source at agent-DnsoYp5b.js:607
  // and server-chat-DVXWYmKw.js:964). The poll fallback in
  // fetchAndAttachHud() guarantees the HUD eventually lands even if this
  // event is missed; this listener just makes it lands fast — usually
  // within tens of ms of the chat-final.
  useEffect(() => {
    return client.onEvent((ev: OpenClawEvent) => {
      if (ev.event !== "sessions.changed") return;
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const evKey = typeof p.sessionKey === "string" ? p.sessionKey : null;
      if (evKey !== sessionKey) return;
      const awaiting = awaitingHudBubbleIdRef.current;
      if (!awaiting) return;
      if (hudAttachedBubbleIdsRef.current.has(awaiting)) {
        awaitingHudBubbleIdRef.current = null;
        return;
      }
      void fetchRowAndAttempt({
        client,
        chatId,
        sessionKey,
        bubbleId: awaiting,
        setItems,
        noteOwnPersist,
        attachedBubbleIds: hudAttachedBubbleIdsRef.current,
      }).then((attached) => {
        if (attached) awaitingHudBubbleIdRef.current = null;
      });
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
        // Peers skip — the originator's persist + plugin broadcast will
        // surface the row across devices via the chat.message listener.
        if (ev.viewerRole === "peer") return;
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
          // The ChatApp-level global persist now writes the assistant final
          // (so it survives navigating away mid-response). That broadcast
          // arrives here with the plugin's UUID — different from the local
          // streamMap-generated bubble id. Skip the inbound copy if the same
          // assistant text already lives in items.
          if (
            msg.role === "assistant"
            && prev.some(
              (it) =>
                it.kind === "message"
                && it.message.role === "assistant"
                && it.message.text === msg.content,
            )
          ) {
            return prev;
          }
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

  // Fetch the session's currently-active model so the chip shows the truth.
  // Soft-fails — gateway builds that don't surface model on sessions.list will
  // simply leave the chip showing "Default".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await client.call<SessionsListResp>("sessions.list", {});
        if (cancelled) return;
        const rows = resp.sessions ?? resp.rows ?? resp.items ?? [];
        const ours = rows.find(
          (r) => (r.sessionKey ?? r.key) === sessionKey,
        );
        if (ours?.resolvedModel) setCurrentModel(ours.resolvedModel);
        else if (ours?.model) setCurrentModel(ours.model);
      } catch (e) {
        // Don't surface — this is best-effort enrichment.
        console.warn("sessions.list (model probe) failed:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [client, sessionKey]);

  const openModelMenu = useCallback(async () => {
    setModelMenuOpen((v) => !v);
    if (availableModels !== null) return;
    setModelMenuErr(null);
    try {
      const resp = await client.call<ModelsListResp>("models.list", {});
      const list = resp.models ?? resp.entries ?? [];
      setAvailableModels(list);
    } catch (e) {
      setModelMenuErr(e instanceof Error ? e.message : String(e));
      setAvailableModels([]);
    }
  }, [client, availableModels]);

  const pickModel = useCallback(
    async (modelId: string | null) => {
      if (modelPatching) return;
      setModelPatching(true);
      setModelMenuErr(null);
      try {
        const result = await client.call<{ resolvedModel?: string; model?: string }>(
          "sessions.patch",
          modelId === null
            ? { key: sessionKey, model: null }
            : { key: sessionKey, model: modelId },
        );
        const next = result?.resolvedModel ?? result?.model ?? modelId;
        setCurrentModel(next);
        setModelMenuOpen(false);
      } catch (e) {
        setModelMenuErr(e instanceof Error ? e.message : String(e));
      } finally {
        setModelPatching(false);
      }
    },
    [client, sessionKey, modelPatching],
  );

  const modelLabel = useMemo(() => {
    if (!currentModel) return "Default";
    // Trim provider prefix for the chip ("anthropic:claude-sonnet-4-6" → "sonnet 4.6").
    const tail = currentModel.split("/").pop()!.split(":").pop()!;
    return tail.replace(/^claude-/, "").replace(/-/g, " ");
  }, [currentModel]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const pendingAttachments = attachments;
    if (!text && pendingAttachments.length === 0) return;
    if (status.kind !== "ready") {
      setErr("Can't send — disconnected from the gateway. Reload the page or check the relay.");
      return;
    }
    if (pending) {
      setErr("Can't send — the previous turn is still running. Tap Reset to recover.");
      return;
    }
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
    onChatStatus?.(chatId, "running");
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
    const optimistic: DisplayMessage = { id: newId(), role: "user", text: displayText, createdMs: Date.now() };
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
      // Attachments balloon the payload (base64 of a phone photo can be 7-13 MB
      // by the time it round-trips relay → tunnel → gateway). 30 s isn't enough
      // headroom; 120 s covers a slow tunnel hop without leaving pending stuck.
      const sendTimeoutMs = oclawAttachments.length > 0 ? 120_000 : 30_000;
      await client.call("chat.send", sendParams, sendTimeoutMs);
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
  }, [client, chatId, projectSlug, sessionKey, input, attachments, status.kind, pending, noteOwnPersist, revokePreviewUrl, listening, onChatStatus]);

  // Answer an inline AskUserQuestion tap-card: send the label as a new user
  // turn (same as OHQ's onAnswer flow). Optimistic-flips the card to answered
  // immediately so a double-tap can't double-send.
  const answerQuestion = useCallback(
    async (toolCallId: string, label: string) => {
      // Only gate on connection status — `pending` would block answers to
      // an AskUserQuestion emitted mid-turn (which is the whole point of
      // the tool). The optimistic "answered" flip below prevents the same
      // card from being double-submitted.
      if (status.kind !== "ready") return;
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
      const optimistic: DisplayMessage = { id: newId(), role: "user", text: label, createdMs: Date.now() };
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
    // Enter inserts a newline (default textarea behaviour). Send via the
    // send button — or Ctrl/Cmd+Enter on desktop as a power-user shortcut.
    // Mobile keyboards never carry the modifier, so they always newline.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
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

  // Thinking indicator. Jesse's spec: dots reflect *live* agent state, not a
  // sticky run flag. Concretely:
  //   - thinking → dots on
  //   - tunnel/gateway disconnected → dots off (run may still be running on
  //     the server, but from the SPA's point of view it can't see it, so don't
  //     pretend)
  //   - tunnel reconnects with run still active → dots come back (the
  //     sessions.list reconcile below repolls on every status→ready and flips
  //     chatStatus back to "running" if the upstream session still has an
  //     active run)
  //   - response final → dots off
  // The parent ChatApp owns chatStatus so it survives this component's
  // unmount (switching chats mid-run); local `pending` covers the brief
  // window between Send and the first server roundtrip.
  const showThinking =
    status.kind === "ready" &&
    (chatStatus === "running" || (pending && chatStatus !== "done"));

  const toolItems = useMemo(
    () => items.flatMap((it) => (it.kind === "tool" ? [it.tool] : [])),
    [items],
  );

  /**
   * Visible items = last `visibleCount` entries. Cheap O(1) array view —
   * skips reconciling the 14k+ older messages on huge chats. Keyed by
   * itemKey so React reuses DOM across input changes.
   */
  const visibleItems = useMemo(
    () => (items.length > visibleCount ? items.slice(-visibleCount) : items),
    [items, visibleCount],
  );
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  const messageCount = items.length;
  const showLargeChatBanner =
    !largeChatDismissed
    && messageCount >= LARGE_CHAT_BANNER_THRESHOLD
    && !!onArchiveAndStartFresh;

  return (
    <div className={`chat-swipe-wrap ${showTerminal ? "with-terminal" : ""}`}>
    <div className="chat-shell">
      <div className="chat-title-bar">
        {editingTitle ? (
          <input
            autoFocus
            className="chat-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitTitleEdit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitTitleEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelTitleEdit();
              }
            }}
            aria-label="Chat title"
          />
        ) : (
          <button
            type="button"
            className="chat-title-button"
            onClick={startEditTitle}
            title="Click to rename this chat"
          >
            <span className="chat-title-text">{chatTitle || "Untitled chat"}</span>
            <span className="chat-title-pencil" aria-hidden="true"><Pencil size={11} /></span>
          </button>
        )}
      </div>
      <button
        type="button"
        className={`chat-terminal-toggle ${showTerminal ? "active" : ""}`}
        onClick={toggleTerminal}
        title={showTerminal ? "Hide terminal panel" : "Show live terminal panel"}
        aria-label="Toggle terminal panel"
        aria-pressed={showTerminal}
      >
        {showTerminal ? "Hide </>" : "</> Terminal"}
      </button>
      <button
        type="button"
        className="chat-reset-session-fab"
        onClick={() => void resetSession()}
        disabled={resettingSession}
        title="Reset agent session — clears agent memory but keeps chat visible"
        aria-label="Reset agent session"
      >
        {resettingSession ? "Resetting…" : "↻ Reset"}
      </button>
      {showLargeChatBanner && (
        <div className="chat-large-banner">
          <div className="chat-large-banner-text">
            This chat has {messageCount.toLocaleString()} messages. Large chats can stall the agent. Archive it and start fresh?
          </div>
          <div className="chat-large-banner-actions">
            <button
              type="button"
              className="chat-large-banner-primary"
              onClick={() => onArchiveAndStartFresh?.(chatId)}
            >
              Archive &amp; start new
            </button>
            <button
              type="button"
              className="chat-large-banner-dismiss"
              onClick={dismissLargeChatBanner}
            >
              Not now
            </button>
          </div>
        </div>
      )}
      <div
        className={`message-list ${dragOver ? "drag-over" : ""}`}
        ref={listRef}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {loading && (
          <div className="empty">
            <div className="big"><Hourglass size={28} /></div>
            Loading chat…
          </div>
        )}
        {!loading && items.length === 0 && status.kind === "ready" && (
          <div className="empty">
            <div className="big"><Chat size={28} /></div>
            Send your first message
            {projectSlug ? <> — project context for <code>{projectSlug}</code> will be attached.</> : null}
          </div>
        )}
        {hiddenCount > 0 && (
          <div className="chat-show-earlier-row">
            <button
              type="button"
              className="chat-show-earlier"
              onClick={() => setVisibleCount((v) => v + 200)}
              title={`Render ${Math.min(200, hiddenCount)} older messages — ${hiddenCount} hidden`}
            >
              Show earlier ({hiddenCount} older)
            </button>
          </div>
        )}
        {visibleItems.map((it) => {
          if (it.kind === "tool") {
            // Tool calls live in the side terminal pane whenever it's visible
            // — always on mobile (swipe-right), and on desktop when the user
            // has toggled the panel on. In those cases we strip them from the
            // chat body so the conversation reads clean; otherwise (desktop +
            // terminal off) we render the inline ToolBlock as a fallback so
            // tools aren't hidden entirely.
            if (isMobile || showTerminal) return null;
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
                // Don't gate on `pending` — the agent emits AskUserQuestion
                // mid-turn precisely because it's waiting on the user, so
                // the buttons MUST be tappable while a turn is in flight.
                // Double-tap is already prevented by the `answered` status
                // flip inside QuestionBlock + answerQuestion's idempotency.
                disabled={status.kind !== "ready"}
              />
            );
          }
          const m = it.message;
          if (m.role === "system") {
            return (
              <SystemRow
                key={itemKey(it)}
                id={m.id}
                text={m.text}
                highlight={initialSearchQuery}
              />
            );
          }
          return (
            <MessageBubble
              key={itemKey(it)}
              message={m}
              highlight={initialSearchQuery}
            />
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

      {stallCompactAvailable && (
        <div className="chat-stall-cta">
          <div className="chat-stall-cta-text">
            Last run stalled — the agent session probably overflowed its buffer.
            Compact it to clear the buffer, then try again.
          </div>
          <div className="chat-stall-cta-actions">
            <button
              type="button"
              className="chat-stall-cta-primary"
              disabled={compacting}
              onClick={async () => {
                if (compacting) return;
                setCompacting(true);
                try {
                  await client.call("sessions.compact", { sessionKey });
                  setStallCompactAvailable(false);
                } catch (e) {
                  setErr(`Compact failed: ${e instanceof Error ? e.message : String(e)}`);
                } finally {
                  setCompacting(false);
                }
              }}
            >
              {compacting ? "Compacting…" : "Compact & resume"}
            </button>
            <button
              type="button"
              className="chat-stall-cta-dismiss"
              onClick={() => setStallCompactAvailable(false)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="composer">
        {showHistoryPicker && (
          <div className="composer-history-picker">
            <div className="composer-history-picker-head">
              <strong>Re-attach from chat history</strong>
              <div className="composer-history-picker-viewtoggle" role="tablist" aria-label="Layout">
                <button
                  type="button"
                  className={`composer-history-picker-viewbtn ${historyViewMode === "list" ? "active" : ""}`}
                  onClick={() => setHistoryViewMode("list")}
                  title="List view"
                  role="tab"
                  aria-selected={historyViewMode === "list"}
                >☰</button>
                <button
                  type="button"
                  className={`composer-history-picker-viewbtn ${historyViewMode === "grid4" ? "active" : ""}`}
                  onClick={() => setHistoryViewMode("grid4")}
                  title="4-up grid"
                  role="tab"
                  aria-selected={historyViewMode === "grid4"}
                >▦</button>
                <button
                  type="button"
                  className={`composer-history-picker-viewbtn ${historyViewMode === "grid1" ? "active" : ""}`}
                  onClick={() => setHistoryViewMode("grid1")}
                  title="Single card preview"
                  role="tab"
                  aria-selected={historyViewMode === "grid1"}
                >▢</button>
              </div>
              <button
                type="button"
                className="composer-history-picker-close"
                aria-label="Close"
                onClick={() => setShowHistoryPicker(false)}
              ><X size={11} /></button>
            </div>
            {historyAttachments.length === 0 ? (
              <div className="composer-history-picker-empty">
                No prior uploads in this chat yet.
              </div>
            ) : (
              <ul className={`composer-history-picker-list mode-${historyViewMode}`}>
                {historyAttachments.map((h) => {
                  const alreadyOn = activeUploadIds.has(h.uploadId);
                  if (historyViewMode === "list") {
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
                  }
                  // grid4 / grid1 — card layout with the image on top, name below.
                  return (
                    <li key={h.uploadId}>
                      <button
                        type="button"
                        className="composer-history-picker-card"
                        disabled={alreadyOn || status.kind !== "ready"}
                        onClick={() => void addHistoryAttachment(h)}
                      >
                        <div className="composer-history-picker-card-imgwrap">
                          <img
                            src={h.url}
                            alt=""
                            className="composer-history-picker-card-img"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = "none";
                            }}
                          />
                          {alreadyOn && (
                            <span className="composer-history-picker-card-on">attached</span>
                          )}
                        </div>
                        <span className="composer-history-picker-card-name" title={h.filename}>
                          {h.filename}
                        </span>
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
                  {a.mimeType.startsWith("image/") ? <Image size={12} /> : <Clipboard size={12} />}
                </span>
                <span className="attachment-name" title={a.filename}>{a.filename}</span>
                <span className="attachment-size">{formatSize(a.size)}</span>
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove ${a.filename}`}
                  onClick={() => removeAttachment(a.localId)}
                ><X size={11} /></button>
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
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
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
          <div className="composer-actions">
            <button
              type="button"
              className="composer-attach"
              aria-label="Attach files"
              title="Attach files"
              disabled={status.kind !== "ready" || pending}
              onClick={() => fileInputRef.current?.click()}
            ><Plus size={14} /></button>
            {historyAttachments.length > 0 && (
              <button
                type="button"
                className={`composer-attach composer-history-trigger ${showHistoryPicker ? "active" : ""}`}
                aria-label="Attach from history"
                title={`Re-attach from chat history (${historyAttachments.length} prior)`}
                disabled={status.kind !== "ready" || pending}
                onClick={() => setShowHistoryPicker((v) => !v)}
              >
                <Clipboard size={14} />
              </button>
            )}
            <div className="composer-model-wrap">
              <button
                type="button"
                className={`composer-model-chip ${modelMenuOpen ? "active" : ""}`}
                aria-haspopup="listbox"
                aria-expanded={modelMenuOpen}
                title={currentModel ? `Active model: ${currentModel}` : "Using gateway default model — tap to pick one"}
                onClick={() => void openModelMenu()}
                disabled={modelPatching}
              >
                {modelLabel}<span className="composer-model-caret" aria-hidden="true"><Chevron dir="down" size={12} /></span>
              </button>
              {modelMenuOpen && (
                <div
                  className="composer-model-menu"
                  role="listbox"
                  onMouseLeave={() => setModelMenuOpen(false)}
                >
                  {modelMenuErr && (
                    <div className="composer-model-menu-err">{modelMenuErr}</div>
                  )}
                  {availableModels === null ? (
                    <div className="composer-model-menu-loading">
                      <span className="spinner" /> Loading models…
                    </div>
                  ) : availableModels.length === 0 ? (
                    <div className="composer-model-menu-empty">
                      No models exposed by gateway. Try the Models page.
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        role="option"
                        className={`composer-model-menu-row ${currentModel === null ? "active" : ""}`}
                        onClick={() => void pickModel(null)}
                        disabled={modelPatching}
                      >
                        <span className="composer-model-menu-name">Default</span>
                        <span className="composer-model-menu-sub">gateway-resolved</span>
                      </button>
                      {availableModels.map((m) => {
                        const isActive = currentModel === m.id || (currentModel === null && m.isDefault);
                        return (
                          <button
                            key={m.id}
                            type="button"
                            role="option"
                            className={`composer-model-menu-row ${isActive ? "active" : ""}`}
                            onClick={() => void pickModel(m.id)}
                            disabled={modelPatching}
                          >
                            <span className="composer-model-menu-name">{m.label ?? m.id}</span>
                            <span className="composer-model-menu-sub">
                              {m.provider ?? ""}{m.isDefault ? " · default" : ""}
                            </span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="composer-actions-spacer" />
            {voiceAvailable && (
              <button
                type="button"
                className={`composer-mic ${listening ? "listening" : ""}`}
                aria-label={listening ? "Stop voice input" : "Start voice input"}
                title={listening ? "Stop voice input" : "Voice input"}
                disabled={status.kind !== "ready" || pending}
                onClick={toggleVoice}
              ><Mic size={14} /></button>
            )}
            <button
              type="button"
              className="send"
              onClick={() => void sendMessage()}
              disabled={!canSend}
              aria-label="send"
            >
              {pending ? <span className="spinner" /> : <ArrowUp size={15} />}
            </button>
          </div>
        </div>
      </div>
    </div>
    <ChatTerminalPanel tools={toolItems} live={pending} />
    </div>
  );
}

function ChatTerminalPanel({ tools, live }: { tools: DisplayTool[]; live: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [tools.length, live]);

  return (
    <aside className="chat-terminal-panel" aria-label="Live terminal feed">
      <div className="chat-terminal-header">
        <span className="chat-terminal-header-label">Terminal</span>
        {live && <span className="chat-terminal-live-dot" aria-hidden="true" />}
      </div>
      <div className="chat-terminal-body" ref={scrollRef}>
        {tools.length === 0 ? (
          <div className="chat-terminal-empty">no activity yet</div>
        ) : (
          tools.map((t) => <ChatTerminalLine key={t.toolCallId} tool={t} />)
        )}
      </div>
    </aside>
  );
}

function ChatTerminalLine({ tool }: { tool: DisplayTool }) {
  const summary = useMemo(() => {
    if (typeof tool.args === "object" && tool.args !== null) {
      const a = tool.args as Record<string, unknown>;
      const cand =
        typeof a.command === "string" ? a.command
        : typeof a.query === "string" ? a.query
        : typeof a.file_path === "string" ? a.file_path
        : typeof a.url === "string" ? a.url
        : typeof a.description === "string" ? a.description
        : null;
      if (cand) return cand.length > 120 ? `${cand.slice(0, 117)}…` : cand;
    }
    return null;
  }, [tool.args]);
  const resultText = useMemo(() => {
    if (tool.status === "running") return null;
    const t = formatToolValue(tool.result);
    if (!t) return null;
    return t.length > 600 ? `${t.slice(0, 600)}\n…[truncated]` : t;
  }, [tool.result, tool.status]);
  return (
    <>
      <div className="chat-terminal-line">
        <span className="chat-terminal-line-arrow">›</span>
        <span>
          <span className="chat-terminal-line-name">{tool.name}</span>
          {summary && <span className="chat-terminal-line-summary">{summary}</span>}
        </span>
      </div>
      {resultText && (
        <div className={`chat-terminal-line-result ${tool.isError ? "err" : ""}`}>
          {resultText}
        </div>
      )}
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

const ToolBlock = React.memo(function ToolBlock({ tool }: { tool: DisplayTool }) {
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
        <span className="tool-block-chevron"><Chevron dir={open ? "down" : "right"} size={12} /></span>
        <span className="tool-block-icon">{fileEdits ? <Pencil size={13} /> : <Tools size={13} />}</span>
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
});

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

const QuestionBlock = React.memo(function QuestionBlock({
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
});

const ApprovalBlock = React.memo(function ApprovalBlock({
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
        <span className="approval-block-icon"><Hand size={14} /></span>
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
});

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

function BubbleHudFooter({ hud }: { hud: { body: string; ctxPct: number | null } }) {
  const pct = hud.ctxPct;
  const fillColor =
    pct === null ? "transparent"
    : pct > 90 ? "var(--maroon, #B83C5C)"
    : pct > 70 ? "var(--accent)"
    : "#4aa064";
  return (
    <div className="bubble-hud">
      <span className="bubble-hud-text">{hud.body}</span>
      {pct !== null && (
        <span className="bubble-hud-ctx" title={`Context: ${pct.toFixed(1)}% of model window`}>
          <span className="bubble-hud-bar" aria-hidden="true">
            <span
              className="bubble-hud-bar-fill"
              style={{ width: `${Math.min(100, pct)}%`, backgroundColor: fillColor }}
            />
          </span>
          <span>ctx {pct.toFixed(0)}%</span>
        </span>
      )}
    </div>
  );
}

/**
 * Memoized chat bubble for user/assistant messages. Wrapping in React.memo
 * means a keystroke in the composer (which is a sibling state update on the
 * parent) doesn't trigger BubbleContent's markdown re-parse for every
 * already-rendered bubble. Custom equality compares the fields we actually
 * render so identity-stable parent re-renders skip.
 */
const MessageBubble = React.memo(
  function MessageBubble({ message, highlight }: { message: DisplayMessage; highlight?: string }) {
    return (
      <div
        data-message-id={message.id}
        className={`bubble ${message.role}`}
      >
        <BubbleContent text={message.text} highlight={highlight} />
        {message.streaming && <span className="streaming-caret" aria-hidden="true" />}
        {!message.streaming && message.role === "assistant" && message.hud && (
          <BubbleHudFooter hud={message.hud} />
        )}
        {!message.streaming && message.createdMs && (
          <div className="bubble-timestamp">{formatBubbleTimestamp(message.createdMs)}</div>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.message === next.message && prev.highlight === next.highlight,
);

const SystemRow = React.memo(function SystemRow({ id, text, highlight }: { id: string; text: string; highlight?: string }) {
  const hud = parseHud(text);
  if (!hud) {
    // Non-HUD system rows (errors, approval markers, free-form notes) — centered,
    // muted, no SYSTEM tag.
    return (
      <div data-message-id={id} className="chat-system-row">
        <BubbleContent text={text} highlight={highlight} />
      </div>
    );
  }
  const pct = hud.ctxPct;
  // OHQ palette: green under 70%, accent up to 90%, red above. Matches the
  // ChatView.tsx reference at src/app/chat/[id]/ChatView.tsx:1304.
  const fillColor =
    pct === null ? "transparent"
    : pct > 90 ? "var(--maroon, #B83C5C)"
    : pct > 70 ? "var(--accent)"
    : "#4aa064";
  return (
    <div data-message-id={id} className="chat-hud-row">
      <span className="chat-hud-text">— {hud.body} —</span>
      {pct !== null && (
        <span className="chat-hud-ctx" title={`Context: ${pct.toFixed(1)}% of model window`}>
          <span className="chat-hud-bar" aria-hidden="true">
            <span
              className="chat-hud-bar-fill"
              style={{ width: `${Math.min(100, pct)}%`, backgroundColor: fillColor }}
            />
          </span>
          <span>ctx {pct.toFixed(0)}%</span>
        </span>
      )}
    </div>
  );
});

type InlinePart =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "link"; text: string; url: string };

type BlockPart =
  | { kind: "inline"; parts: InlinePart[] }
  | { kind: "codeblock"; lang: string; text: string }
  | { kind: "heading"; level: 1 | 2 | 3; parts: InlinePart[] }
  | { kind: "hr" }
  | { kind: "blockquote"; parts: InlinePart[] }
  | { kind: "ul"; items: InlinePart[][] }
  | { kind: "ol"; items: InlinePart[][] };

// Tokenize a single line/segment into inline parts (text + code + bold + italic
// + links). Markers are non-greedy, single-line (newlines break out of bold /
// italic / code spans). Order matters — links first so `[foo](http://...)`
// doesn't get half-eaten by italic matching the asterisk in a URL.
function parseInline(text: string): InlinePart[] {
  const re =
    /\[([^\]]+)\]\(([^)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  const out: InlinePart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined && m[2] !== undefined) {
      out.push({ kind: "link", text: m[1], url: m[2] });
    } else if (m[3] !== undefined) {
      out.push({ kind: "code", text: m[3] });
    } else if (m[4] !== undefined) {
      out.push({ kind: "bold", text: m[4] });
    } else if (m[5] !== undefined) {
      out.push({ kind: "bold", text: m[5] });
    } else if (m[6] !== undefined) {
      out.push({ kind: "italic", text: m[6] });
    } else if (m[7] !== undefined) {
      out.push({ kind: "italic", text: m[7] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

// Classify a paragraph-sized chunk (no fenced code, no blank lines inside) as
// one of the block-level markdown shapes. Defaults to inline-parsed paragraph.
function classifyParagraph(chunk: string): BlockPart {
  const lines = chunk.split("\n");
  const first = lines[0] ?? "";

  // Headings — `# heading` / `## heading` / `### heading`. Multi-line headings
  // are not supported (the model rarely emits them); we accept only the first
  // line and ignore trailing content.
  const headingMatch = first.match(/^(#{1,3})\s+(.+?)\s*#*$/);
  if (headingMatch && lines.length === 1) {
    const level = headingMatch[1]!.length as 1 | 2 | 3;
    return { kind: "heading", level, parts: parseInline(headingMatch[2]!) };
  }

  // Horizontal rule — `---` / `***` / `___` (3+) on a single line.
  if (lines.length === 1 && /^([-*_])\1{2,}\s*$/.test(first)) {
    return { kind: "hr" };
  }

  // Blockquote — every non-empty line starts with `> `.
  if (lines.every((l) => l.trim() === "" || l.startsWith("> "))) {
    const body = lines.map((l) => l.replace(/^>\s?/, "")).join("\n");
    return { kind: "blockquote", parts: parseInline(body) };
  }

  // Unordered list — every line starts with `- ` or `* `.
  if (lines.every((l) => /^[-*]\s+/.test(l))) {
    const items = lines.map((l) => parseInline(l.replace(/^[-*]\s+/, "")));
    return { kind: "ul", items };
  }

  // Ordered list — every line starts with `N. ` or `N) `.
  if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
    const items = lines.map((l) => parseInline(l.replace(/^\d+[.)]\s+/, "")));
    return { kind: "ol", items };
  }

  return { kind: "inline", parts: parseInline(chunk) };
}

// Split text into fenced code blocks vs inline-parsed segments. Fences are
// matched non-greedy with ```[lang]\n...\n```. Outside fences, paragraphs
// (split on blank lines) get classified into heading / hr / blockquote /
// list / inline paragraph shapes.
function parseBlocks(text: string): BlockPart[] {
  const out: BlockPart[] = [];
  const re = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushNonFence = (segment: string) => {
    if (!segment) return;
    const paragraphs = segment.split(/\n{2,}/);
    for (const p of paragraphs) {
      const trimmed = p.replace(/\n+$/, "");
      if (!trimmed) continue;
      out.push(classifyParagraph(trimmed));
    }
  };
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pushNonFence(text.slice(last, m.index));
    out.push({ kind: "codeblock", lang: m[1] ?? "", text: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) pushNonFence(text.slice(last));
  return out;
}

/**
 * Render bubble text with markdown-style inline formatting: links, fenced code
 * blocks, inline `code`, **bold**, *italic*. `/uploads/<id>.<imageExt>` links
 * also get an inline thumbnail so the chat shows what was actually sent after
 * a reload. Optionally highlights case-insensitive matches of `highlight` with
 * `<mark>`.
 */
function renderInlinePart(p: InlinePart, i: number, highlight?: string): React.ReactNode {
  if (p.kind === "text") return <span key={i}>{highlightText(p.text, highlight)}</span>;
  if (p.kind === "code")
    return <code key={i} className="bubble-inline-code">{highlightText(p.text, highlight)}</code>;
  if (p.kind === "bold") return <strong key={i}>{highlightText(p.text, highlight)}</strong>;
  if (p.kind === "italic") return <em key={i}>{highlightText(p.text, highlight)}</em>;
  const url = p.url;
  const isImage = isInlineImageUrl(url);
  // Attachment links are persisted as `[📎 filename](url)` in chat history
  // (kept emoji for parser back-compat with OHQ-imported chats). Strip the
  // emoji from the rendered label and prepend a Clip icon so the chat UI
  // stays emoji-free even though the wire format keeps the marker.
  const isAttachment = p.text.startsWith("📎");
  const label = isAttachment ? p.text.replace(/^📎\s*/, "") : p.text;
  return (
    <span key={i} className={isImage ? "bubble-link-image-wrap" : undefined}>
      {isImage && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="bubble-image-link">
          <img
            src={url}
            alt={label}
            className="bubble-image-thumb"
            loading="lazy"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        </a>
      )}
      <a href={url} target="_blank" rel="noopener noreferrer" className="bubble-link">
        {isAttachment && <Clip size={12} style={{ marginRight: 4, verticalAlign: "-2px" }} />}
        {highlightText(label, highlight)}
      </a>
    </span>
  );
}

function BubbleContent({ text, highlight }: { text: string; highlight?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <>
      {blocks.map((b, bi) => {
        if (b.kind === "codeblock") {
          return (
            <pre key={bi} className="bubble-codeblock">
              <code>{b.text}</code>
            </pre>
          );
        }
        if (b.kind === "heading") {
          const inner = b.parts.map((p, i) => renderInlinePart(p, i, highlight));
          if (b.level === 1) return <h1 key={bi}>{inner}</h1>;
          if (b.level === 2) return <h2 key={bi}>{inner}</h2>;
          return <h3 key={bi}>{inner}</h3>;
        }
        if (b.kind === "hr") return <hr key={bi} />;
        if (b.kind === "blockquote") {
          return (
            <blockquote key={bi}>
              {b.parts.map((p, i) => renderInlinePart(p, i, highlight))}
            </blockquote>
          );
        }
        if (b.kind === "ul" || b.kind === "ol") {
          const Tag = b.kind === "ul" ? "ul" : "ol";
          return (
            <Tag key={bi}>
              {b.items.map((item, ii) => (
                <li key={ii}>
                  {item.map((p, pi) => renderInlinePart(p, pi, highlight))}
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <span key={bi}>
            {b.parts.map((p, i) => renderInlinePart(p, i, highlight))}
          </span>
        );
      })}
    </>
  );
}
