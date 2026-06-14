#!/usr/bin/env node
/**
 * Phase C step 15 smoke test — skills.install + skills.status RPC reachability.
 *
 * Step 15 wires an Install button per row on SkillsPage. The wiring depends on
 * two RPCs being reachable over the tunnel:
 *   - skills.status (operator.read): fetches installed inventory.
 *   - skills.install (operator.admin): runs the ClawHub install.
 *
 * We don't actually install a skill here (mutates user state + needs network +
 * non-deterministic). Instead we assert:
 *   1. skills.status returns a structured response.
 *   2. skills.install({}) returns a documented INVALID_REQUEST error (proving
 *      the method exists and the SPA's call shape can be probed without
 *      mutating anything).
 *
 * The second check is important: if skills.install were absent or scope-blocked
 * before we got to the validator, we'd see a different error code. INVALID_REQUEST
 * means the method exists, was admitted by scope, and rejected the empty params
 * — exactly what the SPA's first byte of contact would do.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";

let nextId = 1;
const reqId = () => `t-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function openClient() {
  const url = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(url);
  const pending = new Map();
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  ws.on("message", (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
    const frame = env.frame;
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "event") {
      if (frame.event === "claw.session_ready") {
        readyResolve();
      }
      return;
    }
    if (frame.type === "res") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      // Pass both ok and error frames through; the caller decides what's a failure.
      entry.resolve(frame);
    }
  });

  const call = (method, params) => {
    const id = reqId();
    ws.send(JSON.stringify({
      kind: "frame", clientId: "self", direction: "client-to-agent",
      frame: { type: "req", id, method, params },
    }));
    return new Promise((resolve) => { pending.set(id, { resolve }); });
  };
  return { ws, ready, call };
}

async function main() {
  const c = openClient();
  await c.ready;

  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // 1. skills.status returns a structured response (the source of the installed
  //    pill state).
  const statusFrame = await c.call("skills.status", {});
  if (!statusFrame.ok) {
    fail(`skills.status returned error: ${statusFrame.error?.code} ${statusFrame.error?.message}`);
  } else {
    const payload = statusFrame.payload;
    if (!payload || typeof payload !== "object") {
      fail(`skills.status payload not an object: ${typeof payload}`);
    }
    const list = payload?.skills ?? payload?.installed ?? [];
    if (!Array.isArray(list)) {
      fail(`skills.status .skills/.installed not an array: ${typeof list}`);
    } else {
      console.log(`  skills.status ok — ${list.length} entries reported`);
    }
  }

  // 2. skills.install probe with empty params — should error but NOT with
  //    "method not found" or scope errors. We accept INVALID_REQUEST, INVALID_ARGUMENT,
  //    or similar param-shape errors as proof the method is reachable.
  const installFrame = await c.call("skills.install", {});
  if (installFrame.ok) {
    // Surprisingly succeeded (no-op default install?). Not a failure but log it.
    console.log(`  skills.install({}) unexpectedly returned ok — gateway treated empty params as default`);
  } else {
    const code = installFrame.error?.code ?? "";
    const message = installFrame.error?.message ?? "";
    const reachable = /INVALID/.test(code) || /required|missing|invalid/i.test(message);
    if (!reachable) {
      fail(`skills.install errored with non-validator code "${code}" — method may be unreachable: ${message}`);
    } else {
      console.log(`  skills.install probe ok — validator rejected empty params as expected (${code})`);
    }
  }

  c.ws.close();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: skills.status + skills.install reachable for SkillsPage install action\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
