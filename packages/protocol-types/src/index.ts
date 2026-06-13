/**
 * Shared types for OpenClaw Gateway Protocol v4 frames as they flow through
 * Claw HQ's relay. Source of truth: ~/.npm-global/lib/node_modules/openclaw/docs/gateway/protocol.md
 *
 * Phase 1 keeps this surface deliberately small. We treat OpenClaw frames as
 * opaque-but-shaped JSON — relay never parses payloads, only routes them.
 */

export const GATEWAY_PROTOCOL_VERSION = 4 as const;

export type OpenClawFrame = OpenClawRequest | OpenClawResponse | OpenClawEvent;

export interface OpenClawRequest {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

export interface OpenClawResponse {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message: string; details?: unknown };
}

export interface OpenClawEvent {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: number;
}

export function isOpenClawFrame(value: unknown): value is OpenClawFrame {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "req" || type === "res" || type === "event";
}

/**
 * Frames exchanged between tunnel-agent and cloud-relay on the outer envelope.
 *
 * Phase 1 has no per-user routing or auth. The relay tells the tunnel agent
 * when each client attaches/detaches; the tunnel agent then owns a 1:1
 * mapping from clientId -> a fresh Gateway WS session so each client gets
 * its own OpenClaw connect.challenge handshake.
 */
export type TunnelEnvelope =
  | TunnelHelloEnvelope
  | TunnelHelloOkEnvelope
  | TunnelClientAttachedEnvelope
  | TunnelClientDetachedEnvelope
  | TunnelFrameEnvelope
  | TunnelByeEnvelope;

export interface TunnelHelloEnvelope {
  kind: "hello";
  /** Phase 1: hardcoded tenant id; Phase 2: derived from operator device token. */
  tenant: string;
  agentVersion: string;
}

export interface TunnelHelloOkEnvelope {
  kind: "hello-ok";
  /** Relay-issued connection id, useful for logging. */
  connId: string;
}

/** relay -> agent: open a fresh Gateway session for this client. */
export interface TunnelClientAttachedEnvelope {
  kind: "client-attached";
  clientId: string;
}

/** relay -> agent: close the Gateway session for this client. */
export interface TunnelClientDetachedEnvelope {
  kind: "client-detached";
  clientId: string;
  reason: string;
}

export interface TunnelFrameEnvelope {
  kind: "frame";
  /** Which client this frame belongs to. */
  clientId: string;
  /**
   * Direction is implicit from the WS sender, but we tag it so logs are
   * unambiguous and so the relay can fan-out without re-tagging.
   */
  direction: "agent-to-client" | "client-to-agent";
  /** Opaque OpenClaw frame. Relay does not parse beyond logging. */
  frame: OpenClawFrame;
}

export interface TunnelByeEnvelope {
  kind: "bye";
  reason: string;
}

export function isTunnelEnvelope(value: unknown): value is TunnelEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "hello" ||
    kind === "hello-ok" ||
    kind === "client-attached" ||
    kind === "client-detached" ||
    kind === "frame" ||
    kind === "bye"
  );
}
