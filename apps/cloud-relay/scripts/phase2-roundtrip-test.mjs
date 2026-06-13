#!/usr/bin/env node
/**
 * Phase 2 end-to-end test, exercising the new multi-tenant relay + transparent
 * handshake design:
 *   1. POST /api/auth/login (or signup) to get a session cookie.
 *   2. Open ws://localhost:3838/ws/client with the cookie.
 *   3. Wait for the synthetic `claw.session_ready` event from the tunnel.
 *   4. Send chat.send directly (no OpenClaw connect on this side).
 *   5. Watch for chat events and verify the final reply.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const EMAIL = process.env.CLAW_HQ_EMAIL ?? "frank@example.com";
const PASSWORD = process.env.CLAW_HQ_PASSWORD ?? "testpassword123";

function log(kind, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${kind.padEnd(6)} ${msg}`);
}

async function login() {
  const res = await fetch(`${RELAY}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no set-cookie header");
  // Extract just `chq_session=...` (first attribute).
  const cookie = setCookie.split(",").map((s) => s.split(";")[0].trim()).find((c) => c.startsWith("chq_session="));
  if (!cookie) throw new Error("session cookie not found");
  return cookie;
}

let nextId = 1;
const requestId = () => `c-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

async function main() {
  const cookie = await login();
  log("LOGIN", `got cookie`);

  const wsUrl = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(wsUrl, { headers: { cookie } });

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
    log("SEND", `${frame.method ?? frame.type} ${JSON.stringify(frame).slice(0, 100)}`);
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
        const p = frame.payload ?? {};
        log("READY", `protocol=${p.protocol} scopes=${(p.scopes ?? []).join(",")}`);
        chatRunId = requestId();
        sendFrame({
          type: "req",
          id: chatRunId,
          method: "chat.send",
          params: {
            sessionKey: "agent:main:main",
            message: "Reply with just the single word: ok",
            idempotencyKey: `claw-hq-phase2-${Date.now()}`,
          },
        });
        return;
      }
      if (frame.event === "relay.agent_offline") {
        log("FAIL", "tunnel agent is offline; start it with `pnpm dev:tunnel`");
        try { ws.close(); } catch {}
        return;
      }
      if (frame.event === "claw.session_failed") {
        log("FAIL", `session failed: ${JSON.stringify(frame.payload)}`);
        try { ws.close(); } catch {}
        return;
      }
      // Other events — log briefly.
      const payloadStr = JSON.stringify(frame.payload ?? {});
      log("EV", `${frame.event} ${payloadStr.slice(0, 140)}${payloadStr.length > 140 ? "…" : ""}`);

      if (frame.event === "chat" && frame.payload?.state === "final") {
        const parts = frame.payload?.message?.content;
        if (Array.isArray(parts)) {
          const textPart = parts.find((p) => p && p.type === "text" && typeof p.text === "string");
          if (textPart) chatFinalText = textPart.text;
        }
        if (chatFinalText) {
          log("DONE", `chat final: "${chatFinalText}"`);
          try { ws.close(1000, "phase2-test complete"); } catch {}
        }
      }
      return;
    }

    if (frame.type === "res") {
      log("RES", `id=${frame.id} ok=${frame.ok} ${JSON.stringify(frame.payload ?? frame.error ?? {}).slice(0, 100)}`);
    }
  });
}

main().catch((err) => {
  console.error("[test] fatal:", err.message);
  process.exit(2);
});
