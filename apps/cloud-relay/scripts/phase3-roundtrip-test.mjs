#!/usr/bin/env node
/**
 * Phase 3 end-to-end test — exercises the new single-tenant trusted-lan mode.
 * No login required (auth mode = trusted-lan), tunnel handshakes transparently,
 * `chat.send` should stream a final reply.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";

function log(kind, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${kind.padEnd(6)} ${msg}`);
}

let nextId = 1;
const requestId = () => `c-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

async function main() {
  // Sanity: GET /api/auth/me in trusted-lan mode returns the synthetic owner.
  const me = await fetch(`${RELAY}/api/auth/me`).then((r) => r.json());
  log("ME", JSON.stringify(me));

  const wsUrl = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(wsUrl);

  let chatRunId = null;
  let chatFinalText = null;
  let timedOut = false;

  const wallTimeout = setTimeout(() => {
    timedOut = true;
    log("FAIL", "wall-clock timeout 30s");
    try { ws.close(); } catch {}
  }, 30_000);

  ws.on("open", () => log("OPEN", `ws ${wsUrl}`));
  ws.on("close", (code, reason) => {
    clearTimeout(wallTimeout);
    log("CLOSE", `code=${code} reason=${reason?.toString() || "(none)"}`);
    if (chatFinalText) {
      console.log(`\n  Result: "${chatFinalText}"\n`);
      process.exit(0);
    }
    process.exit(timedOut || !chatFinalText ? 1 : 0);
  });
  ws.on("error", (err) => log("ERR", err.message));

  const sendFrame = (frame) => {
    log("SEND", `${frame.method ?? frame.type}`);
    ws.send(JSON.stringify({ kind: "frame", clientId: "self", direction: "client-to-agent", frame }));
  };

  ws.on("message", (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
    const frame = env.frame;
    if (!frame || typeof frame !== "object") return;

    if (frame.type === "event") {
      if (frame.event === "claw.session_ready") {
        log("READY", `protocol=${frame.payload?.protocol} scopes=${(frame.payload?.scopes ?? []).join(",")}`);
        chatRunId = requestId();
        sendFrame({
          type: "req",
          id: chatRunId,
          method: "chat.send",
          params: {
            sessionKey: "agent:main:main",
            message: "Reply with just the single word: ok",
            idempotencyKey: `phase3-${Date.now()}`,
          },
        });
        return;
      }
      if (frame.event === "relay.agent_offline") {
        log("FAIL", "tunnel offline");
        try { ws.close(); } catch {}
        return;
      }
      if (frame.event === "chat" && frame.payload?.state === "final") {
        const parts = frame.payload?.message?.content;
        if (Array.isArray(parts)) {
          const t = parts.find((p) => p && p.type === "text" && typeof p.text === "string");
          if (t) chatFinalText = t.text;
        }
        if (chatFinalText) {
          log("DONE", `chat final: "${chatFinalText}"`);
          try { ws.close(1000, "phase3-test complete"); } catch {}
        }
      }
    }
  });
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
