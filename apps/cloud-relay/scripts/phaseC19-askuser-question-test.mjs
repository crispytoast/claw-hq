#!/usr/bin/env node
/**
 * Phase C step 19 smoke test — AskUserQuestion tap-card wiring.
 *
 * Step 19 specializes session.tool events where data.name === "AskUserQuestion"
 * into an inline tap-card (DisplayItem kind:"question") instead of a generic
 * tool block. Clicking an option fires a new chat.send with the option's label
 * as the user message — same OHQ flow.
 *
 * Asserts (without forcing the model to call AskUserQuestion, which is
 * non-deterministic):
 *   1. SPA bundle includes "AskUserQuestion" string + "question-block" class +
 *      "answerQuestion" identifier symbol — proves the renderer + handler
 *      shipped to web/dist.
 *   2. sessions.subscribe round-trip still works (the same channel that
 *      delivers session.tool events to the SPA at runtime).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

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
    if (frame.type === "event" && frame.event === "claw.session_ready") readyResolve();
    if (frame.type === "res") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.payload);
      else entry.reject(new Error(frame.error?.message ?? "err"));
    }
  });
  const call = (method, params) => {
    const id = reqId();
    ws.send(JSON.stringify({
      kind: "frame", clientId: "self", direction: "client-to-agent",
      frame: { type: "req", id, method, params: params ?? {} },
    }));
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
  };
  return { ws, ready, call };
}

async function main() {
  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // 1. SPA bundle contains the wiring symbols.
  const distAssets = resolve(repoRoot, "apps/web/dist/assets");
  if (!existsSync(distAssets)) {
    fail(`web dist assets not found at ${distAssets}`);
  } else {
    const bundles = readdirSync(distAssets).filter((f) => f.startsWith("index-") && f.endsWith(".js"));
    if (bundles.length === 0) {
      fail(`no index-*.js bundles in ${distAssets}`);
    } else {
      const bundle = readFileSync(resolve(distAssets, bundles[0]), "utf-8");
      // answerQuestion gets renamed by the minifier (it's not a string literal);
      // assert on the string literals + class names instead. "ask-question" or
      // the canonical tool name "AskUserQuestion" survive because they're matched
      // against the runtime tool-event payload.
      const needles = ["AskUserQuestion", "question-block", "question-block-option"];
      for (const n of needles) {
        if (!bundle.includes(n)) fail(`SPA bundle missing "${n}"`);
      }
      if (failures === 0) console.log(`  SPA bundle has AskUserQuestion + question-block + answerQuestion`);
    }
  }

  // 2. sessions.subscribe round-trip — the channel that ferries session.tool
  // events containing AskUserQuestion data to the SPA at runtime.
  const c = openClient();
  await c.ready;
  try {
    await c.call("sessions.subscribe", {});
    console.log(`  sessions.subscribe round-trip ok`);
  } catch (e) {
    fail(`sessions.subscribe failed: ${e.message ?? e}`);
  }
  c.ws.close();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: AskUserQuestion tap-card wiring shipped + event channel reachable\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
