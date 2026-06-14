/**
 * Tunnel module — callable from the CLI or standalone.
 *
 * Maintains one outbound WebSocket to the relay (`ws://relay/ws/agent`) and
 * per-client Gateway sessions opened lazily on `client-attached` events.
 *
 * Does the OpenClaw `connect` handshake on each client's behalf so the
 * browser never sees the Gateway shared-secret token.
 */
import { WebSocket } from "ws";
import {
  isOpenClawFrame,
  isTunnelEnvelope,
  type OpenClawFrame,
  type TunnelEnvelope,
} from "@claw-hq/protocol-types";
import { discoverOpenClaw } from "./openclaw-config.js";
import {
  buildDeviceConnectBlock,
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from "./device-identity.js";

export interface TunnelOptions {
  /** Relay URL — ws://host:port (no path). The tunnel appends /ws/agent. */
  relayUrl: string;
  /** Pairing token for the relay's /ws/agent endpoint. */
  pairingToken: string;
  /** Path to OpenClaw's config file (Gateway URL + token auto-read). */
  openclawConfigPath: string;
  /** Exit the process when the relay rejects the pairing token. */
  exitOnAuthFailure?: boolean;
}

export interface TunnelHandle {
  stop(reason?: string): Promise<void>;
}

const AGENT_VERSION = "0.0.3";
const TUNNEL_CONNECT_PREFIX = "tunnel-connect-";
const TUNNEL_PLATFORM = "linux";
const TUNNEL_DEVICE_FAMILY = "claw-hq-tunnel";
const REQUESTED_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.admin",
];

type SessionState = "handshaking" | "ready";

interface GatewaySession {
  ws: WebSocket;
  state: SessionState;
  pendingToRelay: OpenClawFrame[];
  pendingToGateway: OpenClawFrame[];
  gatewayToken: string;
}

export function startTunnel(opts: TunnelOptions): TunnelHandle {
  let relay: WebSocket | null = null;
  let shuttingDown = false;
  let relayBackoffMs = 1_000;
  const gateways = new Map<string, GatewaySession>();
  let deviceIdentity: DeviceIdentity | null = null;
  void loadOrCreateDeviceIdentity()
    .then((id) => {
      deviceIdentity = id;
      console.log(
        `[tunnel] device identity ready id=${id.deviceId.slice(0, 12)}…`,
      );
    })
    .catch((err) => {
      console.warn(
        `[tunnel] device identity load failed (will connect without it): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

  const relayAgentUrl = () => {
    const base = opts.relayUrl.replace(/\/+$/, "");
    return `${base}/ws/agent?token=${encodeURIComponent(opts.pairingToken)}`;
  };

  const safeSendRelay = (envelope: TunnelEnvelope): void => {
    if (!relay || relay.readyState !== 1) return;
    relay.send(JSON.stringify(envelope));
  };

  const connectRelay = (): void => {
    if (shuttingDown) return;
    const url = relayAgentUrl();
    console.log(`[tunnel] dial relay ${url.replace(/token=[^&]+/, "token=…")}`);
    const ws = new WebSocket(url);
    relay = ws;

    ws.on("open", () => {
      console.log("[tunnel] relay open");
      relayBackoffMs = 1_000;
      safeSendRelay({ kind: "hello", tenant: "self", agentVersion: AGENT_VERSION });
      for (const [clientId, session] of gateways) {
        if (session.pendingToRelay.length > 0) {
          for (const frame of session.pendingToRelay) {
            safeSendRelay({ kind: "frame", clientId, direction: "agent-to-client", frame });
          }
          session.pendingToRelay = [];
        }
      }
    });

    ws.on("message", (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (!isTunnelEnvelope(parsed)) return;
      handleRelayEnvelope(parsed);
    });

    ws.on("close", (code, reason) => {
      console.log(`[tunnel] relay close code=${code} reason=${reason.toString() || "(none)"}`);
      relay = null;
      if (code === 1008) {
        if (opts.exitOnAuthFailure) {
          console.error("[tunnel] relay rejected pairing token. Run `claw-hq pair <new-token>`.");
          process.exit(1);
        }
        // In-process: shouldn't happen, but if it does, give up rather than spin.
        return;
      }
      scheduleRelayReconnect();
    });

    ws.on("error", (err) => {
      console.warn(`[tunnel] relay error: ${err.message}`);
    });
  };

  const scheduleRelayReconnect = (): void => {
    if (shuttingDown) return;
    const delay = relayBackoffMs;
    relayBackoffMs = Math.min(relayBackoffMs * 2, 30_000);
    setTimeout(connectRelay, delay);
  };

  const handleRelayEnvelope = (envelope: TunnelEnvelope): void => {
    switch (envelope.kind) {
      case "hello-ok":
        console.log(`[tunnel] hello-ok conn=${envelope.connId}`);
        return;
      case "client-attached":
        attachClient(envelope.clientId);
        return;
      case "client-detached":
        detachClient(envelope.clientId, envelope.reason);
        return;
      case "frame":
        if (envelope.direction === "client-to-agent") {
          forwardClientFrameToGateway(envelope.clientId, envelope.frame);
        }
        return;
      case "bye":
        console.log(`[tunnel] relay bye: ${envelope.reason}`);
        return;
    }
  };

  const attachClient = (clientId: string): void => {
    if (gateways.has(clientId)) return;

    let discovery;
    try {
      discovery = discoverOpenClaw(opts.openclawConfigPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tunnel] cannot read OpenClaw config: ${msg}`);
      safeSendRelay({
        kind: "frame",
        clientId,
        direction: "agent-to-client",
        frame: {
          type: "event",
          event: "relay.gateway_unavailable",
          payload: { error: msg },
        },
      });
      return;
    }

    console.log(`[tunnel] dial gateway ${discovery.gatewayUrl} clientId=${clientId}`);
    const ws = new WebSocket(discovery.gatewayUrl);
    const session: GatewaySession = {
      ws,
      state: "handshaking",
      pendingToRelay: [],
      pendingToGateway: [],
      gatewayToken: discovery.gatewayToken,
    };
    gateways.set(clientId, session);

    ws.on("open", () => console.log(`[tunnel] gateway open clientId=${clientId} (handshaking)`));

    ws.on("message", (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (!isOpenClawFrame(parsed)) return;
      handleGatewayFrame(clientId, parsed);
    });

    ws.on("close", (code, reason) => {
      console.log(`[tunnel] gateway close clientId=${clientId} code=${code} reason=${reason.toString() || "(none)"}`);
      gateways.delete(clientId);
    });

    ws.on("error", (err) => {
      console.warn(`[tunnel] gateway error clientId=${clientId}: ${err.message}`);
    });
  };

  const detachClient = (clientId: string, reason: string): void => {
    const session = gateways.get(clientId);
    if (!session) return;
    console.log(`[tunnel] close gateway clientId=${clientId} reason=${reason}`);
    if (session.ws.readyState <= 1) session.ws.close(1000, reason);
    gateways.delete(clientId);
  };

  const forwardClientFrameToGateway = (clientId: string, frame: OpenClawFrame): void => {
    const session = gateways.get(clientId);
    if (!session) return;
    if (frame.type === "req" && frame.method === "connect") {
      safeSendRelay({
        kind: "frame",
        clientId,
        direction: "agent-to-client",
        frame: {
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            message: "connect is handled by the tunnel agent; this client should not send it",
            details: { code: "TUNNEL_HANDSHAKE_OWNED" },
          },
        },
      });
      return;
    }
    if (session.state === "handshaking") {
      const LIMIT = 100;
      if (session.pendingToGateway.length >= LIMIT) session.pendingToGateway.shift();
      session.pendingToGateway.push(frame);
      return;
    }
    if (session.ws.readyState !== 1) return;
    session.ws.send(JSON.stringify(frame));
  };

  const handleGatewayFrame = (clientId: string, frame: OpenClawFrame): void => {
    const session = gateways.get(clientId);
    if (!session) return;

    if (session.state === "handshaking") {
      if (frame.type === "event" && frame.event === "connect.challenge") {
        const payload = (frame.payload ?? {}) as Record<string, unknown>;
        const nonce =
          typeof payload.nonce === "string" ? payload.nonce.trim() : "";
        const signedAtMs = Date.now();
        const baseParams = {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "gateway-client",
            version: AGENT_VERSION,
            platform: TUNNEL_PLATFORM,
            deviceFamily: TUNNEL_DEVICE_FAMILY,
            mode: "backend",
          },
          role: "operator",
          scopes: REQUESTED_SCOPES,
          caps: [],
          commands: [],
          permissions: {},
          auth: { token: session.gatewayToken },
          locale: "en-US",
          userAgent: `claw-hq-tunnel/${AGENT_VERSION}`,
        };
        const params: Record<string, unknown> = { ...baseParams };
        if (deviceIdentity && nonce) {
          params.device = buildDeviceConnectBlock({
            identity: deviceIdentity,
            clientId: baseParams.client.id,
            clientMode: baseParams.client.mode,
            role: baseParams.role,
            scopes: baseParams.scopes,
            signedAtMs,
            token: session.gatewayToken,
            nonce,
            platform: TUNNEL_PLATFORM,
            deviceFamily: TUNNEL_DEVICE_FAMILY,
          });
        }
        const connectReq: OpenClawFrame = {
          type: "req",
          id: `${TUNNEL_CONNECT_PREFIX}${clientId}`,
          method: "connect",
          params,
        };
        if (session.ws.readyState === 1) session.ws.send(JSON.stringify(connectReq));
        return;
      }

      if (frame.type === "res" && frame.id.startsWith(TUNNEL_CONNECT_PREFIX)) {
        if (!frame.ok) {
          console.warn(`[tunnel] gateway connect rejected clientId=${clientId}: ${frame.error?.message}`);
          forwardGatewayFrameToRelay(clientId, {
            type: "event",
            event: "claw.session_failed",
            payload: { error: frame.error?.message ?? "connect rejected" },
          });
          if (session.ws.readyState <= 1) session.ws.close(1000, "connect rejected");
          gateways.delete(clientId);
          return;
        }
        const payload = (frame.payload ?? {}) as Record<string, unknown>;
        const auth = (payload.auth ?? {}) as Record<string, unknown>;
        session.state = "ready";
        console.log(`[tunnel] gateway ready clientId=${clientId} protocol=${payload.protocol}`);
        forwardGatewayFrameToRelay(clientId, {
          type: "event",
          event: "claw.session_ready",
          payload: {
            protocol: payload.protocol,
            role: auth.role,
            scopes: auth.scopes,
            server: payload.server,
          },
        });
        for (const queued of session.pendingToGateway) {
          if (session.ws.readyState === 1) session.ws.send(JSON.stringify(queued));
        }
        session.pendingToGateway = [];
        return;
      }

      forwardGatewayFrameToRelay(clientId, frame);
      return;
    }

    forwardGatewayFrameToRelay(clientId, frame);
  };

  const forwardGatewayFrameToRelay = (clientId: string, frame: OpenClawFrame): void => {
    if (relay && relay.readyState === 1) {
      safeSendRelay({ kind: "frame", clientId, direction: "agent-to-client", frame });
      return;
    }
    const session = gateways.get(clientId);
    if (!session) return;
    const LIMIT = 1000;
    if (session.pendingToRelay.length >= LIMIT) session.pendingToRelay.shift();
    session.pendingToRelay.push(frame);
  };

  connectRelay();

  return {
    async stop(reason = "tunnel stop") {
      shuttingDown = true;
      for (const [clientId, session] of gateways) {
        if (session.ws.readyState <= 1) session.ws.close(1000, reason);
        gateways.delete(clientId);
      }
      if (relay && relay.readyState <= 1) {
        safeSendRelay({ kind: "bye", reason });
        relay.close(1000, reason);
      }
    },
  };
}
