#!/usr/bin/env node
/**
 * Phase 1 connectivity smoke — the cheapest possible "relay + tunnel are alive"
 * check. Just open `/ws/client` and wait for the synthetic `claw.session_ready`
 * event the tunnel-agent issues once its silent-local-pairing handshake
 * completes.
 *
 * Pre-Phase-B-step-4a this test did the manual `connect` round-trip itself,
 * reading the gateway token out of apps/tunnel-agent/config.json. That file is
 * gitignored and the SPA no longer touches the gateway token at all — the
 * tunnel does the handshake transparently. Rewriting against the current model.
 *
 * Exits 0 on success, 1 on failure.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const TIMEOUT_MS = 10_000;

function log(kind, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${kind.padEnd(6)} ${msg}`);
}

const wsUrl = RELAY.replace(/^http/, "ws") + "/ws/client";
const ws = new WebSocket(wsUrl);
let ready = false;

const timer = setTimeout(() => {
  log("FAIL", `no claw.session_ready within ${TIMEOUT_MS}ms`);
  try { ws.close(); } catch { /* noop */ }
  process.exit(1);
}, TIMEOUT_MS);

ws.on("open", () => log("OPEN", wsUrl));
ws.on("error", (err) => log("ERR", `ws ${err.message}`));
ws.on("close", (code, reason) => {
  if (!ready) {
    log("CLOSE", `ws code=${code} reason=${reason?.toString() || "(none)"}`);
    process.exit(1);
  }
});

ws.on("message", (raw) => {
  let env;
  try { env = JSON.parse(raw.toString()); } catch { return; }
  if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
  const frame = env.frame;
  if (!frame || typeof frame !== "object" || frame.type !== "event") return;

  if (frame.event === "claw.session_ready") {
    ready = true;
    const p = frame.payload ?? {};
    log("READY", `protocol=${p.protocol ?? "?"} scopes=${(p.scopes ?? []).join(",")}`);
    clearTimeout(timer);
    try { ws.close(1000, "phase1 ok"); } catch { /* noop */ }
    console.log(`\n  Result: claw.session_ready received from tunnel\n`);
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (frame.event === "relay.agent_offline") {
    log("FAIL", "relay reports tunnel-agent offline");
    clearTimeout(timer);
    try { ws.close(); } catch { /* noop */ }
    process.exit(1);
    return;
  }
  if (frame.event === "claw.session_failed") {
    log("FAIL", `session failed: ${JSON.stringify(frame.payload ?? {})}`);
    clearTimeout(timer);
    try { ws.close(); } catch { /* noop */ }
    process.exit(1);
    return;
  }
});
