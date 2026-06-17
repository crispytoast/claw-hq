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
} from "@claw-hq/protocol-types";
import type Database from "better-sqlite3";
import { findPairingToken, touchPairingToken } from "./db.js";
import type { ResolvedConfig } from "./config.js";
import { resolveOwner } from "./auth.js";
import { deliverNotification } from "./push.js";
import { appendAssistantFinalIfNew, resolveClawhqChatIdFromPrefix } from "./chats-storage.js";

interface SingleTenantState {
  agent: WebSocket | null;
  /** User id this agent's tunnel-agent is bound to. */
  agentOwnerId: string | null;
  clients: Map<string, WebSocket>;
}

const CLAWHQ_SESSION_RE = /^agent:main:clawhq-([A-Za-z0-9-]+)$/;

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

    const clawhq = sessionKey.match(CLAWHQ_SESSION_RE);
    const summary = messageObj ? frameToText(messageObj.content).trim() : "";
    const body = summary
      ? summary.length > 120 ? summary.slice(0, 117) + "..." : summary
      : "Tap to open the chat.";

    if (clawhq && clawhq[1]) {
      return {
        title: "Response ready",
        body,
        kind: "chat.complete",
        deepLink: `/chat-detail/${clawhq[1]}`,
        data: { chatIdPrefix: clawhq[1], sessionKey },
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
  const state: SingleTenantState = { agent: null, agentOwnerId: null, clients: new Map() };

  function ownerIdForAgentToken(token: string): string {
    if (inProcessAgentToken && token === inProcessAgentToken) {
      // Single-host trusted-lan default: the synthetic owner.
      return "owner";
    }
    const row = findPairingToken(db, token);
    return row?.user_id ?? "owner";
  }

  function maybePersistAssistantFinal(envelope: TunnelEnvelope): void {
    if (envelope.kind !== "frame") return;
    const frame = envelope.frame;
    if (frame.type !== "event" || frame.event !== "chat") return;
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    if (payload.state !== "final") return;
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
    if (!sessionKey) return;
    const clawhq = sessionKey.match(CLAWHQ_SESSION_RE);
    if (!clawhq || !clawhq[1]) return;
    const messageObj = (payload.message ?? null) as Record<string, unknown> | null;
    const role = messageObj && typeof messageObj.role === "string" ? messageObj.role : "";
    if (role !== "assistant") return;
    const content = messageObj ? frameToText(messageObj.content).trim() : "";
    if (!content) return;
    // chatId prefix is 8 chars; we need the full id to find the file. The
    // SPA already resolves prefix→full via clawhq.chats.list. Walk the chats
    // directory to find the unique chat whose id starts with the prefix.
    void resolveClawhqChatIdFromPrefix(clawhq[1])
      .then(async (chatId) => {
        if (!chatId) return;
        const res = await appendAssistantFinalIfNew({ chatId, content });
        if (res.appended) {
          console.log(`[chats] server-side appended assistant final to ${chatId.slice(0, 8)} (offline client)`);
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
    if (f.event === "exec.approval.requested") {
      const data = (p.data ?? {}) as Record<string, unknown>;
      const id = typeof data.approvalId === "string" ? data.approvalId : null;
      if (!id) return null;
      return `${sessionKey}::approval::${id}`;
    }
    return null;
  }

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
          maybeFirePushFromFrame(envelope);
          // Server-side safety net: if NO SPA client is connected at all,
          // persist the assistant message ourselves so the SPA can render
          // it on next reload. Without this, a phone that locked mid-
          // response would never see the reply because the SPA's own
          // clawhq.chats.append never ran.
          //
          // We deliberately check `state.clients.size === 0` (not just the
          // envelope's own clientId) because orphan-pool gateway sessions
          // emit envelopes whose original clientId is no longer in the
          // routing map — but a freshly-reconnected SPA holds a DIFFERENT
          // clientId that's actively persisting. Skipping when any client
          // is online avoids racing two writers to the chat file.
          if (state.clients.size === 0) {
            maybePersistAssistantFinal(envelope);
          }
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

        if (envelope.kind === "frame" && envelope.direction === "client-to-agent") {
          const tagged: TunnelEnvelope = { ...envelope, clientId };
          if (state.agent && state.agent.readyState === 1) {
            state.agent.send(JSON.stringify(tagged));
          }
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
