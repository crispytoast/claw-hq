/**
 * WebSocket client for the cloud relay's /ws/client endpoint.
 *
 * Talks the Tunnel envelope protocol with the relay. The tunnel agent handles
 * OpenClaw's connect handshake on our behalf and emits a synthetic
 * `claw.session_ready` event when the Gateway session is live. After that we
 * can call OpenClaw methods (chat.send, sessions.list, etc.) by sending raw
 * OpenClaw frames wrapped in a TunnelFrameEnvelope.
 */
import type {
  OpenClawFrame,
  OpenClawRequest,
  OpenClawResponse,
  OpenClawEvent,
} from "@claw-hq/protocol-types";

export type ConnectionStatus =
  | { kind: "connecting" }
  | { kind: "agent-offline" } // tunnel agent isn't connected yet
  | { kind: "session-handshaking" }
  | { kind: "ready"; protocol: number; scopes: string[] }
  | { kind: "failed"; reason: string }
  | { kind: "closed"; code: number; reason: string };

type EventListener = (event: OpenClawEvent) => void;
type StatusListener = (status: ConnectionStatus) => void;

interface PendingRequest {
  resolve(payload: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

let nextRequestSeq = 1;

function makeRequestId(): string {
  return `c-${nextRequestSeq++}-${Math.random().toString(36).slice(2, 6)}`;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = { kind: "connecting" };
  private pending = new Map<string, PendingRequest>();
  private eventListeners = new Set<EventListener>();
  private statusListeners = new Set<StatusListener>();
  private shouldReconnect = true;
  private reconnectBackoffMs = 1_000;

  constructor(private readonly url: string) {}

  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  shutdown(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      try { this.ws.close(1000, "client shutdown"); } catch { /* noop */ }
      this.ws = null;
    }
    for (const req of this.pending.values()) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(new Error("client shutdown"));
    }
    this.pending.clear();
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => { this.statusListeners.delete(listener); };
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  /**
   * Send an OpenClaw method call. Resolves with the payload of the matching res.
   */
  call<T = unknown>(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`ws not open (status=${this.status.kind})`));
    }
    if (this.status.kind !== "ready") {
      return Promise.reject(new Error(`session not ready (${this.status.kind})`));
    }
    const id = makeRequestId();
    const frame: OpenClawRequest = { type: "req", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timer,
      });
      this.sendFrame(frame);
    });
  }

  /** Fire-and-forget OpenClaw notification (rare; usually we want call). */
  notify(method: string, params: unknown = {}): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const id = makeRequestId();
    this.sendFrame({ type: "req", id, method, params });
  }

  private sendFrame(frame: OpenClawFrame): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({
      kind: "frame",
      clientId: "self",
      direction: "client-to-agent",
      frame,
    }));
  }

  private updateStatus(next: ConnectionStatus): void {
    this.status = next;
    for (const listener of this.statusListeners) listener(next);
  }

  private openSocket(): void {
    this.updateStatus({ kind: "connecting" });
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectBackoffMs = 1_000;
      this.updateStatus({ kind: "session-handshaking" });
    });

    ws.addEventListener("close", (ev) => {
      this.ws = null;
      const code = (ev as CloseEvent).code ?? 1006;
      const reason = (ev as CloseEvent).reason ?? "";
      this.updateStatus({ kind: "closed", code, reason });
      if (this.shouldReconnect && code !== 1008) {
        setTimeout(() => this.openSocket(), this.reconnectBackoffMs);
        this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, 30_000);
      }
    });

    ws.addEventListener("error", () => { /* surfaced via close */ });

    ws.addEventListener("message", (ev) => {
      let envelope: unknown;
      try { envelope = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (!envelope || typeof envelope !== "object") return;
      const obj = envelope as { kind?: string; frame?: unknown; direction?: string };
      if (obj.kind !== "frame" || obj.direction !== "agent-to-client") return;
      const frame = obj.frame as OpenClawFrame;
      if (!frame || typeof frame !== "object") return;

      // Handle synthetic relay events first.
      if (frame.type === "event") {
        if (frame.event === "relay.agent_offline") {
          this.updateStatus({ kind: "agent-offline" });
          return;
        }
        if (frame.event === "claw.session_ready") {
          const p = (frame.payload ?? {}) as { protocol?: number; scopes?: string[] };
          this.updateStatus({
            kind: "ready",
            protocol: p.protocol ?? 4,
            scopes: Array.isArray(p.scopes) ? p.scopes : [],
          });
          // Subscribe to session lifecycle + tool events so chat surfaces can
          // render tool-call collapsibles. Idempotent on the gateway side; the
          // result is ignored. Errors are logged but not fatal.
          this.call("sessions.subscribe", {}).catch((err) => {
            console.warn("sessions.subscribe failed:", err);
          });
          return;
        }
        if (frame.event === "claw.session_failed") {
          const p = (frame.payload ?? {}) as { error?: string };
          this.updateStatus({ kind: "failed", reason: p.error ?? "session failed" });
          return;
        }
        if (frame.event === "relay.gateway_unavailable") {
          const p = (frame.payload ?? {}) as { error?: string };
          this.updateStatus({ kind: "failed", reason: p.error ?? "gateway unavailable" });
          return;
        }
        for (const listener of this.eventListeners) listener(frame);
        return;
      }

      if (frame.type === "res") {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          const errFrame = frame as OpenClawResponse;
          pending.reject(new Error(errFrame.error?.message ?? "request failed"));
        }
        return;
      }
    });
  }
}

// Default URL derived from current page; in dev Vite proxies /ws to relay.
export function defaultGatewayUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws/client`;
}
