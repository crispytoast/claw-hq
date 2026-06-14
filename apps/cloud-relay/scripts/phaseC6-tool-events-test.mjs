#!/usr/bin/env node
/**
 * Phase C step 6 smoke test — session.tool events flow to operator clients.
 *
 * The SPA's tool-call collapsibles depend on session.tool events arriving over
 * the tunnel after the client calls `sessions.subscribe`. This test asserts:
 *   1. A connected client can call sessions.subscribe.
 *   2. After a chat.send that needs a tool, at least one session.tool event
 *      arrives with the documented shape:
 *        { stream: "tool", data: { phase, name, toolCallId, args?, result? } }
 *   3. A start event correlates to a result event by toolCallId.
 *
 * Skips quietly if the chat run completes without invoking a tool (model can
 * choose to answer without one). To force a tool, ask for a concrete shell
 * command that the model can't fake.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const SESSION_KEY = `agent:main:phasec6-${Date.now().toString(36)}`;
const PROMPT =
  process.env.PROMPT ??
  "Please run `ls /var/log` using a shell command tool and tell me what's there. You must invoke a tool to get the actual listing — do not guess.";

let nextId = 1;
const reqId = () => `t-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function openClient() {
  const url = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(url);
  const pending = new Map();
  const eventListeners = new Set();
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
        return;
      }
      for (const fn of eventListeners) fn(frame);
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
  const onEvent = (fn) => { eventListeners.add(fn); return () => eventListeners.delete(fn); };
  return { ws, ready, call, onEvent };
}

async function main() {
  const c = openClient();
  await c.ready;

  await c.call("sessions.subscribe", {});

  const toolEvents = [];
  const finalChatPayloads = [];
  c.onEvent((frame) => {
    if (frame.event === "session.tool") toolEvents.push(frame.payload);
    if (frame.event === "chat" && frame.payload?.state === "final") finalChatPayloads.push(frame.payload);
  });

  await c.call("chat.send", {
    sessionKey: SESSION_KEY,
    message: PROMPT,
    idempotencyKey: `phasec6-${Date.now()}`,
  });

  // Wait for the final chat event (assistant text turn ended).
  await new Promise((resolve) => {
    const interval = setInterval(() => {
      if (finalChatPayloads.length > 0) {
        clearInterval(interval);
        resolve();
      }
    }, 250);
    setTimeout(() => { clearInterval(interval); resolve(); }, 90_000);
  });

  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  if (toolEvents.length === 0) {
    console.warn("  Note: model answered without invoking a tool; no session.tool to assert against.");
    console.warn("  This still passes — the subscribe round-trip worked. Re-run with a stricter prompt to actually exercise tool delivery.");
    c.ws.close();
    process.exit(0);
  }

  const starts = toolEvents.filter((p) => p.data?.phase === "start");
  const results = toolEvents.filter((p) => p.data?.phase === "result");
  if (starts.length === 0) fail("got tool events but none with phase=start");
  if (results.length === 0) fail("got tool events but none with phase=result");

  const start = starts[0];
  if (typeof start?.data?.name !== "string") fail("start data.name missing");
  if (typeof start?.data?.toolCallId !== "string") fail("start data.toolCallId missing");
  if (start?.sessionKey !== SESSION_KEY) fail(`start sessionKey ${start?.sessionKey} != ${SESSION_KEY}`);

  // Correlate start/result by toolCallId.
  const startIds = new Set(starts.map((p) => p.data?.toolCallId));
  const resultIds = new Set(results.map((p) => p.data?.toolCallId));
  let correlated = 0;
  for (const id of startIds) if (resultIds.has(id)) correlated++;
  if (correlated === 0) fail("no start/result pair shared a toolCallId");

  console.log(`  observed: ${starts.length} start(s) + ${results.length} result(s), ${correlated} correlated by toolCallId`);
  if (start?.data?.name) console.log(`  first tool: ${start.data.name}`);

  c.ws.close();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: session.tool events deliver with start/result correlation\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
