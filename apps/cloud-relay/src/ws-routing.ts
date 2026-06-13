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

interface SingleTenantState {
  agent: WebSocket | null;
  clients: Map<string, WebSocket>;
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
  const state: SingleTenantState = { agent: null, clients: new Map() };

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
          if (client && client.readyState === 1) {
            client.send(JSON.stringify(envelope));
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
        if (state.agent === socket) state.agent = null;
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
