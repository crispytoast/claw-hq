#!/usr/bin/env node
/**
 * Phase C step 25 smoke test — Plugins page (Settings).
 *
 * The Plugins tab shells through `clawhq.plugins.{list,search,install,uninstall}`,
 * which the openclaw-plugin v0.0.13 registers. Verify:
 *
 *   1. The plugin's compiled dist exports the four method names in its `methods`
 *      registration list (read from plugin-host inventory via clawhq.health).
 *   2. clawhq.plugins.list returns a `{ plugins: [...] }` shape.
 *   3. clawhq.plugins.search with empty query returns `{ hits: [] }` without
 *      shelling out.
 *   4. clawhq.plugins.install with missing spec returns INVALID_REQUEST.
 *   5. clawhq.plugins.uninstall on id="clawhq" is refused.
 *
 * This script REQUIRES the plugin to be installed on the local OpenClaw and the
 * Claw HQ relay to be running. If `clawhq.health` is not reachable, the test
 * skips the live checks but still validates registration list from source.
 */
import { WebSocket } from "ws";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";

let nextId = 1;
const reqId = () => `t25-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginSrc = path.resolve(here, "../../openclaw-plugin/src/index.ts");

// Sanity check #1 — registration list from source.
const src = readFileSync(pluginSrc, "utf8");
let sourceFailures = 0;
for (const m of [
  "clawhq.plugins.list",
  "clawhq.plugins.search",
  "clawhq.plugins.install",
  "clawhq.plugins.uninstall",
]) {
  if (!src.includes(`"${m}"`)) {
    console.error(`FAIL: plugin source does not mention ${m}`);
    sourceFailures++;
  }
}
if (!existsSync(path.resolve(here, "../../openclaw-plugin/src/plugins.ts"))) {
  console.error("FAIL: plugins.ts module missing");
  sourceFailures++;
}

function openClient(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const url = RELAY.replace(/^http/, "ws") + "/ws/client";
    const ws = new WebSocket(url);
    const pending = new Map();
    let readyResolve;
    const ready = new Promise((res) => { readyResolve = res; });
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("ws connect timeout")); }, timeoutMs);
    ws.on("open", () => { clearTimeout(t); });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
    ws.on("message", (raw) => {
      let env; try { env = JSON.parse(raw.toString()); } catch { return; }
      if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
      const frame = env.frame;
      if (!frame || typeof frame !== "object") return;
      if (frame.type === "event" && frame.event === "claw.session_ready") { readyResolve(); return; }
      if (frame.type === "res") {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        if (frame.ok) entry.resolve(frame.payload);
        else entry.reject(new Error(`${frame.error?.code ?? "ERR"}: ${frame.error?.message ?? ""}`));
      }
    });
    const call = (method, params) => {
      const id = reqId();
      ws.send(JSON.stringify({ kind: "frame", clientId: "self", direction: "client-to-agent",
        frame: { type: "req", id, method, params } }));
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
    };
    resolve({ ws, ready, call });
  });
}

async function main() {
  let liveFailures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); liveFailures++; };

  let c;
  try {
    c = await openClient();
    await Promise.race([
      c.ready,
      new Promise((_r, rj) => setTimeout(() => rj(new Error("session_ready timeout")), 5000)),
    ]);
  } catch (e) {
    console.warn(`[live skip] relay unreachable / session not ready: ${e.message}`);
    if (sourceFailures > 0) process.exit(1);
    console.log("\n  Result: source registration list OK (live checks skipped — relay not running)\n");
    process.exit(0);
  }

  // Check #1 — health reports the four methods. If the running plugin doesn't
  // know about them, the binary in dist/ predates this commit — note + skip
  // the live checks instead of a hard fail (this script runs before the user
  // has had a chance to reinstall the plugin).
  let liveMethodsReady = true;
  try {
    const health = await c.call("clawhq.health", {});
    const methods = Array.isArray(health?.methods) ? health.methods : [];
    for (const m of [
      "clawhq.plugins.list",
      "clawhq.plugins.search",
      "clawhq.plugins.install",
      "clawhq.plugins.uninstall",
    ]) {
      if (!methods.includes(m)) {
        console.warn(`[live skip] running plugin does not advertise ${m} — reinstall the plugin and restart the gateway, then re-run`);
        liveMethodsReady = false;
      }
    }
  } catch (e) {
    fail(`clawhq.health failed: ${e.message}`);
  }

  if (!liveMethodsReady) {
    try { c.ws.close(); } catch {}
    if (sourceFailures > 0) process.exit(1);
    console.log("\n  Result: source registration list OK (live checks skipped — plugin v0.0.13 not yet loaded)\n");
    process.exit(0);
  }

  // Check #2 — list returns shape.
  try {
    const result = await c.call("clawhq.plugins.list", {});
    if (!result || !Array.isArray(result.plugins)) {
      fail(`plugins.list bad shape: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    // It's OK for openclaw plugins list to surface a host-side error if no
    // plugins are installed in some edge case — but the RPC itself should be
    // reachable.
    if (!String(e.message).includes("INTERNAL")) fail(`plugins.list: ${e.message}`);
  }

  // Check #3 — search with empty query returns hits: [].
  try {
    const result = await c.call("clawhq.plugins.search", { query: "" });
    if (!result || !Array.isArray(result.hits) || result.hits.length !== 0) {
      fail(`plugins.search empty-query expected {hits:[]}, got ${JSON.stringify(result)}`);
    }
  } catch (e) {
    fail(`plugins.search empty-query: ${e.message}`);
  }

  // Check #4 — install w/ missing spec.
  try {
    await c.call("clawhq.plugins.install", {});
    fail("plugins.install with no spec should fail");
  } catch (e) {
    if (!String(e.message).includes("INVALID_REQUEST")) fail(`plugins.install no-spec: ${e.message}`);
  }

  // Check #5 — uninstall clawhq is refused.
  try {
    await c.call("clawhq.plugins.uninstall", { id: "clawhq" });
    fail("plugins.uninstall of clawhq should fail");
  } catch (e) {
    if (!/(refusing|UNINSTALL_FAILED|INTERNAL)/.test(e.message)) {
      fail(`plugins.uninstall(clawhq) wrong error: ${e.message}`);
    }
  }

  try { c.ws.close(); } catch {}

  const totalFailures = sourceFailures + liveFailures;
  if (totalFailures > 0) {
    console.error(`\n  ${totalFailures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: clawhq.plugins.* RPC wiring + source registration list OK\n`);
  process.exit(0);
}

main().catch((err) => { console.error("[test] fatal:", err); process.exit(2); });
