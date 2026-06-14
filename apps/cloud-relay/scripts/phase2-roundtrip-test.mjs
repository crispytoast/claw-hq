#!/usr/bin/env node
/**
 * Phase 2 end-to-end chat round-trip:
 *   1. Detect auth mode via /api/auth/me. In trusted-lan mode no login is
 *      needed; in real-auth mode, login with $CLAW_HQ_EMAIL + $CLAW_HQ_PASSWORD.
 *   2. Open /ws/client with the appropriate cookie (or none).
 *   3. Wait for the synthetic `claw.session_ready` event.
 *   4. Fire `chat.send` and assert a final assistant text comes back.
 *
 * Pre-rewrite this hard-coded the real-auth login path even though the dev
 * relay defaults to trusted-lan; the 404 on /api/auth/login was a stale-test
 * symptom, not a regression.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const EMAIL = process.env.CLAW_HQ_EMAIL ?? "frank@example.com";
const PASSWORD = process.env.CLAW_HQ_PASSWORD ?? "testpassword123";
const TIMEOUT_MS = Number(process.env.CLAW_HQ_TIMEOUT_MS ?? 30_000);

function log(kind, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${kind.padEnd(6)} ${msg}`);
}

async function detectAuthMode() {
  const r = await fetch(`${RELAY}/api/auth/me`);
  if (!r.ok) throw new Error(`/api/auth/me returned ${r.status}`);
  return r.json();
}

async function loginRealAuth() {
  const res = await fetch(`${RELAY}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no set-cookie header from login");
  const cookie = setCookie
    .split(",")
    .map((s) => s.split(";")[0].trim())
    .find((c) => c.startsWith("chq_session="));
  if (!cookie) throw new Error("chq_session cookie not found in login response");
  return cookie;
}

let nextId = 1;
const reqId = () => `c-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

async function main() {
  const auth = await detectAuthMode();
  log("AUTH", `mode=${auth.mode} user=${auth.user?.id ?? "?"}`);

  const headers = {};
  if (auth.mode !== "trusted-lan") {
    headers.cookie = await loginRealAuth();
    log("LOGIN", "got chq_session cookie");
  }

  const wsUrl = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(wsUrl, { headers });
  let finalText = null;

  const timer = setTimeout(() => {
    log("FAIL", `wall-clock timeout ${TIMEOUT_MS}ms (final="${finalText ?? "<none>"}")`);
    try { ws.close(); } catch { /* noop */ }
    process.exit(1);
  }, TIMEOUT_MS);

  const sendFrame = (frame) => {
    log("SEND", `${frame.method ?? frame.type}`);
    ws.send(JSON.stringify({ kind: "frame", clientId: "self", direction: "client-to-agent", frame }));
  };

  ws.on("open", () => log("OPEN", wsUrl));
  ws.on("error", (err) => log("ERR", err.message));
  ws.on("close", (code, reason) => {
    clearTimeout(timer);
    log("CLOSE", `code=${code} reason=${reason?.toString() || "(none)"}`);
    if (finalText) {
      console.log(`\n  Result: chat final="${finalText.slice(0, 100)}${finalText.length > 100 ? "…" : ""}"\n`);
      process.exit(0);
    }
    process.exit(1);
  });

  ws.on("message", (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
    const frame = env.frame;
    if (!frame || typeof frame !== "object" || frame.type !== "event") return;

    if (frame.event === "claw.session_ready") {
      const p = frame.payload ?? {};
      log("READY", `protocol=${p.protocol ?? "?"}`);
      sendFrame({
        type: "req",
        id: reqId(),
        method: "chat.send",
        params: {
          sessionKey: "agent:main:phase2-roundtrip",
          message: "Reply with just the single word: ok",
          idempotencyKey: `phase2-${Date.now()}`,
        },
      });
      return;
    }
    if (frame.event === "relay.agent_offline") {
      log("FAIL", "tunnel-agent is offline");
      try { ws.close(); } catch { /* noop */ }
      return;
    }
    if (frame.event === "claw.session_failed") {
      log("FAIL", `session failed: ${JSON.stringify(frame.payload ?? {})}`);
      try { ws.close(); } catch { /* noop */ }
      return;
    }
    if (frame.event === "chat" && frame.payload?.state === "final") {
      const parts = frame.payload?.message?.content;
      if (Array.isArray(parts)) {
        const textPart = parts.find((p) => p && p.type === "text" && typeof p.text === "string");
        if (textPart) finalText = textPart.text;
      }
      if (finalText) {
        log("DONE", `final received`);
        try { ws.close(1000, "phase2 ok"); } catch { /* noop */ }
      }
      return;
    }
  });
}

main().catch((err) => {
  console.error("[test] fatal:", err.message);
  process.exit(2);
});
