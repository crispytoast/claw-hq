/**
 * WebSocket routing for the relay. Single-tenant model:
 *   one agent (the tunnel) + many clients (browser tabs).
 *
 * /ws/agent  — tunnel agent connects with a pairing token (query ?token=...).
 *              In single-host mode the CLI auto-generates a token and passes
 *              it to both sides; in split-process mode the user pairs manually.
 * /ws/client — browser connects authed by the relay's auth mode (cookie or
 *              none in trusted-lan).
 *
 * The relay does not interpret OpenClaw frames — it tags them with a clientId
 * for routing and passes them along.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  isTunnelEnvelope,
  type TunnelEnvelope,
  type TunnelFrameEnvelope,
} from "@claw-hq/protocol-types";
import type Database from "better-sqlite3";
import { findPairingToken, touchPairingToken } from "./db.js";
import type { ResolvedConfig } from "./config.js";
import { resolveOwner } from "./auth.js";
import { deliverNotification } from "./push.js";
import { appendAssistantFinalIfNew, loadChatForFastPath, resolveClawhqChatIdFromPrefix } from "./chats-storage.js";
import { runFastPathTurn } from "./fast-path.js";

interface SingleTenantState {
  agent: WebSocket | null;
  /** User id this agent's tunnel-agent is bound to. */
  agentOwnerId: string | null;
  clients: Map<string, WebSocket>;
  /**
   * Multi-viewer subscriptions: sessionKey -> set of clientIds that asked to
   * watch agent-to-client event frames for that key. Used to fan out copies
   * (tagged viewerRole="peer") to clients other than the originator. Cleaned
   * up on client close.
   */
  watches: Map<string, Set<string>>;
}

/**
 * Matches Claw HQ session keys, regardless of scope prefix.
 *   group 1: scope prefix (`clawhq`, `pmhq`, `oswald`, etc.)
 *   group 2: chatId fragment (first 8 chars of the chat UUID)
 *
 * The scope prefix is captured for future routing (Phase 8.2 specialist
 * boot), but every prefix uses the same chatIdFragment-based deep link
 * (`/chat-detail/<fragment>`) since chatIds are globally unique inside
 * the user's chat store.
 */
const CLAWHQ_SESSION_RE = /^agent:main:([a-z]+)-([A-Za-z0-9-]+)$/;

function frameToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Inspect an agent-to-client OpenClaw frame for events that should fire a push
 * notification. Returns null if the frame is uninteresting.
 *
 * Listens for:
 *   - `chat` event with `payload.state: "final"` and an assistant message —
 *     the same signal the SPA uses to flip a chat dot from amber→green.
 *     Fires per-chat-completion with a deep link into ChatDetailView.
 *   - `exec.approval.requested` event — needs human approval.
 */
function notificationForFrame(envelope: TunnelEnvelope):
  | { title: string; body: string; kind: string; deepLink?: string | null; data?: Record<string, string> }
  | null {
  if (envelope.kind !== "frame" || envelope.direction !== "agent-to-client") return null;
  const frame = envelope.frame;
  if (frame.type !== "event") return null;
  const payload = (frame.payload ?? {}) as Record<string, unknown>;
  const data = (payload.data ?? {}) as Record<string, unknown>;

  if (frame.event === "chat" && payload.state === "final") {
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
    if (!sessionKey) return null;
    const messageObj = (payload.message ?? null) as Record<string, unknown> | null;
    // Only fire for assistant messages — user echoes also flow through `chat`.
    const role = messageObj && typeof messageObj.role === "string" ? messageObj.role : "";
    if (role !== "assistant") return null;

    const scoped = sessionKey.match(CLAWHQ_SESSION_RE);
    const scopePrefix = scoped?.[1] ?? "";
    const chatIdPrefix = scoped?.[2] ?? "";
    const summary = messageObj ? frameToText(messageObj.content).trim() : "";
    const body = summary
      ? summary.length > 120 ? summary.slice(0, 117) + "..." : summary
      : "Tap to open the chat.";

    if (chatIdPrefix) {
      return {
        title: "Response ready",
        body,
        kind: "chat.complete",
        deepLink: `/chat-detail/${chatIdPrefix}`,
        data: { chatIdPrefix, sessionKey, scope: scopePrefix },
      };
    }
    // Non-clawhq session (background agent or raw OpenClaw session).
    return {
      title: "Agent reply ready",
      body,
      kind: "agent.end",
      deepLink: `/chat/${sessionKey}`,
      data: { sessionKey },
    };
  }

  // Failure path: the OpenClaw embedded-backend emits state="error" with an
  // optional errorMessage when a run blows up before producing a reply (e.g.
  // FailoverError, context overflow, CLI output cap), and state="aborted"
  // when a run terminates without producing one. Without this hook the user
  // saw nothing — thinking dots forever, no push, no chat entry. Both states
  // get the same UX as a successful reply: push + persisted synthetic
  // assistant message.
  if (frame.event === "chat" && (payload.state === "error" || payload.state === "aborted")) {
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
    if (!sessionKey) return null;
    const scoped = sessionKey.match(CLAWHQ_SESSION_RE);
    const scopePrefix = scoped?.[1] ?? "";
    const chatIdPrefix = scoped?.[2] ?? "";
    const errMsg = typeof payload.errorMessage === "string" ? payload.errorMessage.trim() : "";
    const reason = errMsg || (payload.state === "aborted" ? "Run aborted." : "Unknown error.");
    const body = reason.length > 120 ? reason.slice(0, 117) + "..." : reason;
    const title = payload.state === "aborted" ? "Agent run stopped" : "Agent run failed";
    if (chatIdPrefix) {
      return {
        title,
        body,
        kind: payload.state === "aborted" ? "chat.aborted" : "chat.error",
        deepLink: `/chat-detail/${chatIdPrefix}`,
        data: { chatIdPrefix, sessionKey, scope: scopePrefix, state: String(payload.state) },
      };
    }
    return {
      title,
      body,
      kind: payload.state === "aborted" ? "agent.aborted" : "agent.error",
      deepLink: `/chat/${sessionKey}`,
      data: { sessionKey, state: String(payload.state) },
    };
  }

  if (frame.event === "exec.approval.requested") {
    const cmd = typeof data.command === "string" ? data.command : "Command";
    return {
      title: "Approval required",
      body: cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd,
      kind: "exec.approval",
      deepLink: "/approvals",
      data: typeof data.approvalId === "string" ? { approvalId: data.approvalId } : undefined,
    };
  }

  return null;
}

interface RoutingDeps {
  db: Database.Database;
  config: ResolvedConfig;
  /** In-process pairing token (single-host mode); when set, the relay accepts it
   *  even if it isn't in the DB. The CLI generates this at startup. */
  inProcessAgentToken?: string;
}

export function registerWsRoutes(fastify: FastifyInstance, deps: RoutingDeps): void {
  const { db, config, inProcessAgentToken } = deps;
  const state: SingleTenantState = { agent: null, agentOwnerId: null, clients: new Map(), watches: new Map() };

  /**
   * Pull the sessionKey out of an agent-to-client event payload, if any. The
   * relay never parses semantics — but every event we'd want to fan out
   * carries `payload.sessionKey` (chat, session.tool, session.changed,
   * exec.approval.*). Frames without one are connection-level and don't fan.
   */
  function eventSessionKey(envelope: TunnelEnvelope): string | null {
    if (envelope.kind !== "frame" || envelope.direction !== "agent-to-client") return null;
    const frame = envelope.frame;
    if (frame.type !== "event") return null;
    const p = (frame.payload ?? {}) as Record<string, unknown>;
    return typeof p.sessionKey === "string" ? p.sessionKey : null;
  }

  /**
   * Fan an agent-to-client event to every peer subscribed to its sessionKey,
   * tagged viewerRole="peer". Originator is excluded (they get the direct
   * delivery one stack frame up). No-op for non-event frames.
   */
  function fanOutToPeers(envelope: TunnelEnvelope): void {
    if (envelope.kind !== "frame") return;
    const sessionKey = eventSessionKey(envelope);
    if (!sessionKey) return;
    const subscribers = state.watches.get(sessionKey);
    if (!subscribers || subscribers.size === 0) return;
    // Build the peer-tagged envelope once and reuse the serialized string —
    // typical case is 1-2 peers but avoid the alloc if 0.
    let serialized: string | null = null;
    for (const peerId of subscribers) {
      if (peerId === envelope.clientId) continue; // originator already got it
      const peerSocket = state.clients.get(peerId);
      if (!peerSocket || peerSocket.readyState !== 1) continue;
      if (serialized === null) {
        const peerEnvelope: TunnelFrameEnvelope = { ...envelope, viewerRole: "peer" };
        serialized = JSON.stringify(peerEnvelope);
      }
      peerSocket.send(serialized);
    }
  }

  function ownerIdForAgentToken(token: string): string {
    if (inProcessAgentToken && token === inProcessAgentToken) {
      // Single-host trusted-lan default: the synthetic owner.
      return "owner";
    }
    const row = findPairingToken(db, token);
    return row?.user_id ?? "owner";
  }

  function maybePersistChatTerminal(envelope: TunnelEnvelope): void {
    if (envelope.kind !== "frame") return;
    const frame = envelope.frame;
    if (frame.type !== "event" || frame.event !== "chat") return;
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    const state = payload.state;
    if (state !== "final" && state !== "error" && state !== "aborted") return;
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
    if (!sessionKey) return;
    const scoped = sessionKey.match(CLAWHQ_SESSION_RE);
    const chatIdPrefix = scoped?.[2] ?? "";
    if (!chatIdPrefix) return;

    let content = "";
    let label = "";
    if (state === "final") {
      const messageObj = (payload.message ?? null) as Record<string, unknown> | null;
      const role = messageObj && typeof messageObj.role === "string" ? messageObj.role : "";
      if (role !== "assistant") return;
      content = messageObj ? frameToText(messageObj.content).trim() : "";
      if (!content) return;
      label = "assistant final";
    } else {
      // Synthesize a `⚠️` assistant bubble so the user sees the failure when
      // they open the chat, instead of dots-spinning-forever. Uses
      // `role: "assistant"` so it renders with no SPA changes; the prefix
      // distinguishes it visually.
      const errMsg = typeof payload.errorMessage === "string" ? payload.errorMessage.trim() : "";
      const reason = errMsg || (state === "aborted" ? "Run aborted before completing." : "Unknown error.");
      const header = state === "aborted" ? "⚠️ Run stopped" : "⚠️ Run failed";
      content = `${header}\n\n${reason}\n\n_(The agent didn't produce a reply. If this keeps happening with the same chat, the conversation history may be too large — start a fresh chat.)_`;
      label = `synthetic ${state}`;
    }

    // chatId prefix is 8 chars; we need the full id to find the file. The
    // SPA already resolves prefix→full via clawhq.chats.list. Walk the chats
    // directory to find the unique chat whose id starts with the prefix.
    void resolveClawhqChatIdFromPrefix(chatIdPrefix)
      .then(async (chatId) => {
        if (!chatId) return;
        const res = await appendAssistantFinalIfNew({ chatId, content });
        if (res.appended) {
          console.log(`[chats] server-side appended ${label} to ${chatId.slice(0, 8)} (offline client)`);
        }
      })
      .catch((err) => {
        console.warn(`[chats] server-side persist failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  // Dedup recent push triggers by sessionKey + message id. The orphan-pool
  // design in the tunnel-agent can leave multiple gateway sessions subscribed
  // to the same OpenClaw sessionKey across SPA reconnects, so OpenClaw
  // broadcasts the chat-final to all of them; without dedup the relay would
  // fire one push per session. Bounded LRU keyed by `${sessionKey}::${msgId}`.
  const pushDedup = new Map<string, number>();
  const PUSH_DEDUP_TTL_MS = 10 * 60_000;

  function pushDedupKey(envelope: TunnelEnvelope): string | null {
    if (envelope.kind !== "frame") return null;
    const f = envelope.frame;
    if (f.type !== "event") return null;
    const p = (f.payload ?? {}) as Record<string, unknown>;
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : "";
    if (f.event === "chat" && p.state === "final") {
      const msg = (p.message ?? null) as Record<string, unknown> | null;
      const id = msg && typeof msg.id === "string" ? msg.id : null;
      // Fall back to a content-hash if no id ships — better dedup than nothing.
      const fallback = msg ? frameToText(msg.content).trim().slice(0, 200) : "";
      const tag = id ?? `c:${fallback}`;
      return `${sessionKey}::chat::${tag}`;
    }
    if (f.event === "chat" && (p.state === "error" || p.state === "aborted")) {
      // Failure path: dedup on runId when present (every emitted terminal
      // event carries one), else fall back to errorMessage so a missing
      // runId still collapses repeats. State is in the key so an error→
      // retry→final sequence won't suppress the eventual final.
      const runId = typeof p.runId === "string" ? p.runId : null;
      const errMsg = typeof p.errorMessage === "string" ? p.errorMessage.slice(0, 200) : "";
      const tag = runId ?? `e:${errMsg}`;
      return `${sessionKey}::${String(p.state)}::${tag}`;
    }
    if (f.event === "exec.approval.requested") {
      const data = (p.data ?? {}) as Record<string, unknown>;
      const id = typeof data.approvalId === "string" ? data.approvalId : null;
      if (!id) return null;
      return `${sessionKey}::approval::${id}`;
    }
    return null;
  }

  // ----- Stuck-run watchdog -----------------------------------------
  // Belt-and-suspenders for failure modes where an OpenClaw run dies but
  // doesn't emit a terminal chat event (e.g. CLI stdout cap blowing up the
  // turn before reply-turn-admission gets a chance to compose a fallback
  // final). Without this, the SPA's thinking dots spin forever, no push
  // fires, no chat bubble lands — exactly the failure Frank hit on
  // 2026-06-18 morning.
  //
  // We track per-sessionKey the wall-clock of the last agent-to-client
  // frame. Any activity (delta, tool start/end, etc.) bumps it. Terminal
  // states clear it. A sweeper checks every minute: if a session's
  // lastActivityMs is older than RUN_STUCK_IDLE_MS, we synthesize a
  // chat:error envelope and feed it through the same handlers — push goes
  // out, ⚠️ bubble lands in the chat file, SPA dots stop, sidebar dot
  // flips to "done".
  interface RunWatch {
    sessionKey: string;
    lastActivityMs: number;
    /** Last runId observed on a frame for this session, propagated into
     *  the synthetic terminal so per-runId dedup keys line up. */
    lastRunId?: string;
    /** Number of automatic retries already attempted for this turn.
     *  Capped at MAX_AUTO_RETRIES so a deterministic failure mode
     *  (e.g. context overflow) doesn't loop forever. */
    retryCount: number;
    /** Cached client-to-agent chat.send envelope. Replayed verbatim on
     *  stall (with a fresh req id). Cleared on terminal so we don't
     *  retry a turn that already finished. */
    lastPromptEnvelope?: TunnelEnvelope;
    /** The clientId we use to replay — preferred is the original
     *  client's id, falling back to any currently-connected client. */
    lastClientId?: string;
  }
  const runWatch = new Map<string, RunWatch>();
  const MAX_AUTO_RETRIES = 1;
  /** Frank's bar: "I need to be able to send a prompt and forget about it
   *  until I get the push notification." 10 min of total radio silence on
   *  an active run is well past any normal work window. */
  const RUN_STUCK_IDLE_MS = 10 * 60_000;
  const RUN_WATCHDOG_CHECK_MS = 60_000;

  function watchdogArmFromClient(envelope: TunnelEnvelope): void {
    if (envelope.kind !== "frame" || envelope.direction !== "client-to-agent") return;
    const frame = envelope.frame;
    if (frame.type !== "req") return;
    // Chat sends ride one of two methods depending on SPA path. Match
    // both; ignore everything else (RPC/tool calls don't arm a turn).
    if (frame.method !== "chat.send" && frame.method !== "sessions.messages.send") return;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const sessionKey =
      typeof params.sessionKey === "string"
        ? params.sessionKey
        : typeof params.key === "string"
        ? params.key
        : "";
    if (!sessionKey || !CLAWHQ_SESSION_RE.test(sessionKey)) return;
    const existing = runWatch.get(sessionKey);
    if (existing) {
      existing.lastActivityMs = Date.now();
      existing.lastPromptEnvelope = envelope;
      existing.lastClientId = envelope.clientId;
      // Fresh user turn — reset retry budget. A real new prompt from the
      // user always gets a fresh single-retry allowance regardless of
      // whether prior turns burned theirs.
      existing.retryCount = 0;
    } else {
      runWatch.set(sessionKey, {
        sessionKey,
        lastActivityMs: Date.now(),
        retryCount: 0,
        lastPromptEnvelope: envelope,
        lastClientId: envelope.clientId,
      });
    }
  }

  function watchdogTouch(envelope: TunnelEnvelope): void {
    if (envelope.kind !== "frame" || envelope.direction !== "agent-to-client") return;
    const frame = envelope.frame;
    if (frame.type !== "event") return;
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
    if (!sessionKey) return;
    // Only watch clawhq-scoped sessions; raw OpenClaw sessions don't have
    // a chat-id prefix and can't be deep-linked from a push.
    if (!CLAWHQ_SESSION_RE.test(sessionKey)) return;

    // Terminal states clear the tracker — the run finished cleanly (or via
    // our earlier error/aborted wiring).
    if (frame.event === "chat" && (payload.state === "final" || payload.state === "error" || payload.state === "aborted")) {
      runWatch.delete(sessionKey);
      return;
    }

    // Touch ONLY an existing watch. Creating a watch on agent-emitted
    // frames is unsafe: after a `state: "final"` clears the tracker, the
    // very next session.changed / heartbeat / tool-result frame would
    // re-arm a watch with no user prompt behind it, and 10 min of normal
    // idle silence later the watchdog would synthesize a phantom
    // "Run failed" error. Watch creation is owned exclusively by
    // watchdogArmFromClient (real user prompts).
    const existing = runWatch.get(sessionKey);
    if (!existing) return;
    const runId = typeof payload.runId === "string" ? payload.runId : undefined;
    existing.lastActivityMs = Date.now();
    if (runId) existing.lastRunId = runId;
  }

  /** Replay the cached chat.send envelope as a fresh turn. Returns true
   *  if the retry was actually attempted (envelope cached + agent attached),
   *  false if we can't retry and should fail loud instead. */
  function attemptStallRetry(watch: RunWatch): boolean {
    if (!watch.lastPromptEnvelope) return false;
    if (watch.retryCount >= MAX_AUTO_RETRIES) return false;
    if (!state.agent || state.agent.readyState !== 1) return false;
    const original = watch.lastPromptEnvelope;
    if (original.kind !== "frame" || original.frame.type !== "req") return false;

    // Reuse the original client's gateway session if it's still attached.
    // Otherwise fall back to any currently-connected client so the tunnel
    // can route. (Tunnel-agent's orphan-pool keeps gateway sessions alive
    // across SPA reconnects, so a stale clientId may still have a live
    // gateway session bound to the same OpenClaw sessionKey.)
    let clientIdForReplay = watch.lastClientId ?? "";
    if (!state.clients.has(clientIdForReplay)) {
      const anyClientId = state.clients.keys().next().value;
      if (typeof anyClientId === "string") clientIdForReplay = anyClientId;
    }
    if (!clientIdForReplay) return false;

    const replayed: TunnelEnvelope = {
      ...original,
      clientId: clientIdForReplay,
      frame: {
        ...original.frame,
        // Fresh req id so OpenClaw doesn't dedup against the dead request.
        id: `retry-${randomUUID()}`,
      },
    };
    watch.retryCount += 1;
    watch.lastActivityMs = Date.now();
    console.warn(`[watchdog] auto-retry #${watch.retryCount} for ${watch.sessionKey} via clientId=${clientIdForReplay}`);
    sendEnvelope(state.agent, replayed);
    return true;
  }

  function synthesizeStuckRunFailure(watch: RunWatch): void {
    // Try the silent recovery path first. If retry kicks in, the watchdog
    // timer is reset and we'll re-check in another 10 min.
    if (attemptStallRetry(watch)) return;

    const retryNote = watch.retryCount > 0
      ? ` Already auto-retried ${watch.retryCount}× without success — this looks like a deterministic failure (likely the chat is too large, or OpenClaw is in a bad state). Start a fresh chat or restart OpenClaw.`
      : "";
    const synth: TunnelEnvelope = {
      kind: "frame",
      // Synthetic; not addressed to any one client — broadcast below.
      clientId: "watchdog",
      direction: "agent-to-client",
      frame: {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: watch.sessionKey,
          state: "error",
          errorMessage: `Agent run timed out — no output for 10 minutes.${retryNote}`,
          // Tell the SPA this was a stall, not a model error — it can offer
          // one-tap session.compact to clear the Claude CLI buffer before
          // the next turn. This is the recovery path for the OpenClaw
          // gateway's turn-output buffer ceiling.
          syntheticReason: "stall",
          canCompact: true,
          ...(watch.lastRunId ? { runId: watch.lastRunId } : {}),
        },
      },
    };
    console.warn(`[watchdog] giving up on ${watch.sessionKey} after ${watch.retryCount} retries — synthesizing chat:error`);
    maybeFirePushFromFrame(synth);
    maybePersistChatTerminal(synth);
    for (const client of state.clients.values()) {
      if (client.readyState === 1) client.send(JSON.stringify(synth));
    }
    runWatch.delete(watch.sessionKey);
  }

  setInterval(() => {
    const now = Date.now();
    for (const watch of runWatch.values()) {
      if (now - watch.lastActivityMs >= RUN_STUCK_IDLE_MS) {
        synthesizeStuckRunFailure(watch);
      }
    }
  }, RUN_WATCHDOG_CHECK_MS).unref();

  function maybeFirePushFromFrame(envelope: TunnelEnvelope): void {
    if (!state.agentOwnerId) return;
    const n = notificationForFrame(envelope);
    if (!n) return;
    const dedupKey = pushDedupKey(envelope);
    if (dedupKey) {
      const now = Date.now();
      // Reap expired entries cheaply on each touch.
      if (pushDedup.size > 256) {
        for (const [k, ts] of pushDedup) {
          if (now - ts > PUSH_DEDUP_TTL_MS) pushDedup.delete(k);
        }
      }
      if (pushDedup.has(dedupKey)) {
        console.log(`[push] dedup hit ${dedupKey.slice(0, 80)} — skipping duplicate notification`);
        return;
      }
      pushDedup.set(dedupKey, now);
    }
    void deliverNotification(
      { db, config },
      {
        userId: state.agentOwnerId,
        title: n.title,
        body: n.body,
        kind: n.kind,
        deepLink: n.deepLink ?? null,
        data: n.data,
      },
    ).catch((err) => {
      console.warn(`[push] deliverNotification threw: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  function sendEnvelope(socket: WebSocket, envelope: TunnelEnvelope): void {
    if (socket.readyState !== 1) return;
    socket.send(JSON.stringify(envelope));
  }

  /**
   * Inspect a client-to-agent chat.send envelope and route to the fast-path
   * if the chat opted into it. Returns true when fast-path took the request
   * (caller MUST NOT also forward to the gateway). Returns false to mean
   * "fall back to the normal gateway path".
   */
  async function maybeFastPath(
    envelope: TunnelEnvelope,
    socket: WebSocket,
    clientId: string,
  ): Promise<boolean> {
    if (envelope.kind !== "frame") return false;
    if (envelope.direction !== "client-to-agent") return false;
    const frame = envelope.frame;
    if (frame.type !== "req") return false;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const sessionKey =
      typeof params.sessionKey === "string"
        ? params.sessionKey
        : typeof params.key === "string"
        ? params.key
        : "";
    if (!sessionKey || !CLAWHQ_SESSION_RE.test(sessionKey)) return false;

    const m = sessionKey.match(CLAWHQ_SESSION_RE);
    const chatPrefix = m?.[2];
    if (!chatPrefix) return false;

    const chatId = await resolveClawhqChatIdFromPrefix(chatPrefix);
    if (!chatId) return false;

    const chat = await loadChatForFastPath(chatId);
    if (!chat || chat.mode !== "fast") return false;

    // Extract the prompt text. The SPA sends `message: <string>` or
    // an array of content parts. Stringify defensively.
    const rawMsg = params.message;
    let promptText = "";
    if (typeof rawMsg === "string") promptText = rawMsg;
    else if (Array.isArray(rawMsg)) {
      promptText = rawMsg
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object" && "text" in p && typeof (p as { text?: unknown }).text === "string") {
            return (p as { text: string }).text;
          }
          return "";
        })
        .join("\n");
    } else if (rawMsg && typeof rawMsg === "object" && "text" in rawMsg) {
      promptText = String((rawMsg as { text?: unknown }).text ?? "");
    }
    if (!promptText.trim()) {
      // Send an error response back to the SPA's pending call() promise
      // and stop. No point spawning claude for empty input.
      sendEnvelope(socket, {
        kind: "frame",
        clientId,
        direction: "agent-to-client",
        frame: {
          type: "res",
          id: frame.id,
          ok: false,
          error: { message: "Fast-path: empty prompt" },
        },
      });
      return true;
    }

    // Acknowledge the SPA's chat.send req synchronously so the client.call
    // promise resolves and the SPA stops waiting. The real result streams
    // back via chat events.
    sendEnvelope(socket, {
      kind: "frame",
      clientId,
      direction: "agent-to-client",
      frame: {
        type: "res",
        id: frame.id,
        ok: true,
        payload: { mode: "fast" },
      },
    });

    // Fire and forget — fast-path handles its own errors via chat:error events.
    void runFastPathTurn(
      { clients: state.clients },
      {
        chatId,
        sessionKey,
        reqId: frame.id,
        promptText,
        ...(typeof params.model === "string" ? { model: params.model } : {}),
      },
    ).catch((e) => {
      console.error(`[fast-path] turn crashed chatId=${chatId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    });

    return true;
  }

  function safeParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  function verifyAgentToken(token: string): boolean {
    if (!token) return false;
    if (inProcessAgentToken && token === inProcessAgentToken) return true;
    return Boolean(findPairingToken(db, token));
  }

  // ---------------- /ws/agent (tunnel) ----------------
  fastify.get(
    "/ws/agent",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const token = url.searchParams.get("token") ?? "";
      if (!verifyAgentToken(token)) {
        console.warn(`[relay] /ws/agent: invalid pairing token`);
        socket.close(1008, "invalid pairing token");
        return;
      }
      // Touch the token in the DB if it's persisted (not the in-process one).
      if (!inProcessAgentToken || token !== inProcessAgentToken) {
        touchPairingToken(db, token);
      }

      const connId = randomUUID();
      const isInProcess = inProcessAgentToken === token;
      console.log(`[relay] +agent conn=${connId} ${isInProcess ? "(in-process)" : "(paired)"}`);

      if (state.agent && state.agent.readyState <= 1) {
        console.warn(`[relay] replacing previous agent connection`);
        state.agent.close(1000, "replaced");
      }
      state.agent = socket;
      state.agentOwnerId = ownerIdForAgentToken(token);

      socket.on("message", (raw) => {
        const parsed = safeParse(raw.toString());
        if (!isTunnelEnvelope(parsed)) return;
        const envelope = parsed;

        if (envelope.kind === "hello") {
          sendEnvelope(socket, { kind: "hello-ok", connId });
          // Replay any already-attached clients so a reconnecting agent rebuilds sessions.
          for (const clientId of state.clients.keys()) {
            sendEnvelope(socket, { kind: "client-attached", clientId });
          }
          return;
        }

        if (envelope.kind === "frame" && envelope.direction === "agent-to-client") {
          const client = state.clients.get(envelope.clientId);
          const delivered = client && client.readyState === 1;
          if (delivered) {
            client.send(JSON.stringify(envelope));
          }
          // Multi-viewer fanout. The originator above is the addressed client
          // (untagged); peers subscribed via client-watch get a copy tagged
          // viewerRole="peer" so the SPA can suppress duplicate chat-storage
          // writes. Only events with a payload.sessionKey fan; res frames and
          // synthetic relay events stay 1:1.
          fanOutToPeers(envelope);
          watchdogTouch(envelope);
          maybeFirePushFromFrame(envelope);
          // Server-side persistence is unconditional. appendAssistantFinalIfNew
          // is file-locked and content-deduped, so a concurrent SPA-side append
          // is safe — the second writer sees "duplicate" and no-ops.
          //
          // Previously we gated this on `state.clients.size === 0`, but that
          // dropped the assistant-final whenever the SPA was open on a
          // different chat OR had reconnected with a fresh clientId after the
          // orphan-pool session was minted. The original clientId on the
          // envelope is then stale, `client.send` above goes nowhere, and the
          // SPA's clawhq.chats.append never runs — so the reply evaporated.
          //
          // Also handles state="error"/"aborted" terminals — those land a
          // synthetic `⚠️ Run failed` assistant bubble so the user sees the
          // failure when they next open the chat.
          maybePersistChatTerminal(envelope);
          return;
        }

        if (envelope.kind === "bye") {
          socket.close(1000, envelope.reason);
          return;
        }
      });

      socket.on("close", (code, reason) => {
        console.log(`[relay] -agent conn=${connId} code=${code} reason=${reason.toString() || "(none)"}`);
        if (state.agent === socket) {
          state.agent = null;
          state.agentOwnerId = null;
        }
      });

      socket.on("error", (err) => {
        console.warn(`[relay] agent error: ${err.message}`);
      });
    },
  );

  // ---------------- /ws/client (browser) ----------------
  fastify.get(
    "/ws/client",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      const owner = resolveOwner(request, config, db);
      if (!owner) {
        socket.close(1008, "unauthenticated");
        return;
      }

      const clientId = randomUUID();
      console.log(`[relay] +client clientId=${clientId} owner=${owner.id}`);
      state.clients.set(clientId, socket);

      if (state.agent && state.agent.readyState === 1) {
        sendEnvelope(state.agent, { kind: "client-attached", clientId });
      } else {
        // Synthetic event so the UI can render "tunnel offline" instead of just hanging.
        sendEnvelope(socket, {
          kind: "frame",
          clientId,
          direction: "agent-to-client",
          frame: {
            type: "event",
            event: "relay.agent_offline",
            payload: {},
          },
        });
      }

      socket.on("message", (raw) => {
        const parsed = safeParse(raw.toString());
        if (!isTunnelEnvelope(parsed)) return;
        const envelope = parsed;

        if (envelope.kind === "client-watch") {
          let subscribers = state.watches.get(envelope.sessionKey);
          if (!subscribers) {
            subscribers = new Set();
            state.watches.set(envelope.sessionKey, subscribers);
          }
          subscribers.add(clientId);
          return;
        }

        if (envelope.kind === "client-unwatch") {
          const subscribers = state.watches.get(envelope.sessionKey);
          if (subscribers) {
            subscribers.delete(clientId);
            if (subscribers.size === 0) state.watches.delete(envelope.sessionKey);
          }
          return;
        }

        if (envelope.kind === "frame" && envelope.direction === "client-to-agent") {
          // Fast-path interception (Phase 9.1). For chat.send requests on a
          // clawhq session whose backing chat has mode==="fast", bypass the
          // gateway entirely and run claude -p directly from the relay. The
          // disk read is small (chat metadata only); we fire-and-forget the
          // runFastPathTurn so this handler returns immediately.
          if (
            envelope.frame.type === "req" &&
            (envelope.frame.method === "chat.send" || envelope.frame.method === "sessions.messages.send")
          ) {
            void maybeFastPath(envelope, socket, clientId).then((handled) => {
              if (handled) return;
              // Fall through to the gateway.
              const tagged: TunnelEnvelope = { ...envelope, clientId };
              if (state.agent && state.agent.readyState === 1) {
                state.agent.send(JSON.stringify(tagged));
              }
              watchdogArmFromClient(envelope);
            });
            return;
          }

          const tagged: TunnelEnvelope = { ...envelope, clientId };
          if (state.agent && state.agent.readyState === 1) {
            state.agent.send(JSON.stringify(tagged));
          }
          // Arm the watchdog the moment a user prompt leaves the relay,
          // even before OpenClaw acks. Otherwise a turn that dies before
          // emitting any frame (rare, but possible — auth failure, queue
          // overflow, etc.) would never arm the agent-side timer.
          watchdogArmFromClient(envelope);
          return;
        }

        if (envelope.kind === "bye") {
          socket.close(1000, envelope.reason);
          return;
        }
      });

      socket.on("close", (code, reason) => {
        console.log(`[relay] -client clientId=${clientId} code=${code} reason=${reason.toString() || "(none)"}`);
        state.clients.delete(clientId);
        // GC this client from every sessionKey watch set so we don't leak
        // dead clientIds. Map size is bounded by active sessionKeys (~10s)
        // so a full sweep is cheap.
        for (const [key, subs] of state.watches) {
          if (subs.delete(clientId) && subs.size === 0) state.watches.delete(key);
        }
        if (state.agent && state.agent.readyState === 1) {
          sendEnvelope(state.agent, {
            kind: "client-detached",
            clientId,
            reason: reason.toString() || `code-${code}`,
          });
        }
      });

      socket.on("error", (err) => {
        console.warn(`[relay] client error clientId=${clientId}: ${err.message}`);
      });
    },
  );
}
