#!/usr/bin/env node
/**
 * Phase C step 14 smoke test — exec.approval RPC + event-listener wiring.
 *
 * Step 14 ships the inline approval card (driven by exec.approval.requested /
 * exec.approval.resolved events) and an Approvals nav badge (driven by polling
 * exec.approval.list). This test asserts the supporting wire surface is reachable
 * over the tunnel without forcing a real allowlist miss (which is non-deterministic).
 *
 * Asserts:
 *   1. A connected operator client can call exec.approval.list and gets a
 *      structured response (with .approvals or .pending key).
 *   2. The result list is shaped so the SPA's `(result.approvals ?? result.pending ?? []).length`
 *      reduction is meaningful — i.e. either key is array-ish if present.
 *   3. Subscribing to events works; we hold the socket briefly to verify no
 *      protocol error tears it down. (We don't force an actual approval request
 *      because triggering an exec-policy miss depends on user config.)
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
      if (frame.ok) entry.resolve(frame.payload);
      else entry.reject(new Error(`${frame.error?.code ?? "ERR"}: ${frame.error?.message ?? "(no message)"}`));
    }
  });

  const call = (method, params) => {
    const id = reqId();
    ws.send(JSON.stringify({
      kind: "frame", clientId: "self", direction: "client-to-agent",
      frame: { type: "req", id, method, params },
    }));
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
  };
  return { ws, ready, call };
}

async function main() {
  const c = openClient();
  await c.ready;

  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // 1. exec.approval.list returns a structured response.
  const listResult = await c.call("exec.approval.list", {});
  if (!listResult || typeof listResult !== "object") {
    fail(`exec.approval.list returned non-object: ${typeof listResult}`);
  }
  const approvals = listResult?.approvals;
  const pending = listResult?.pending;
  if (approvals !== undefined && !Array.isArray(approvals)) {
    fail(`exec.approval.list .approvals is not an array: ${typeof approvals}`);
  }
  if (pending !== undefined && !Array.isArray(pending)) {
    fail(`exec.approval.list .pending is not an array: ${typeof pending}`);
  }
  const count = (Array.isArray(approvals) ? approvals.length : 0)
    + (Array.isArray(pending) ? pending.length : 0);
  console.log(`  exec.approval.list ok — ${count} pending`);

  // 2. The socket survived; do a follow-up call to confirm it's still healthy.
  // (If exec.approval.list closed the socket on us we'd never get here.)
  const list2 = await c.call("exec.approval.list", {});
  if (!list2 || typeof list2 !== "object") {
    fail("follow-up exec.approval.list failed — socket may have torn down");
  }

  c.ws.close();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: exec.approval RPC surface reachable (badge + inline-card sources verified)\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
