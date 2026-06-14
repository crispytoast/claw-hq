#!/usr/bin/env node
/**
 * Phase C step 9 smoke test — tool calls persist into chat history.
 *
 *   1. Create a chat.
 *   2. Append a role:"tool" message with a JSON tool-call payload.
 *   3. Reload history and assert the entry survives with role:"tool" + the
 *      same toolCallId/name/result.
 *   4. Cleanup.
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
  return { ws, ready, call };
}

async function main() {
  const c = openClient();
  await c.ready;

  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  const created = await c.call("clawhq.chats.create", { title: "phaseC9-tool-persist" });
  const chatId = created.chat.id;
  console.log(`  created chat ${chatId}`);

  const toolPayload = {
    toolCallId: "toolu_phasec9_xyz",
    name: "Bash",
    args: { command: "ls /tmp", description: "list tmp" },
    result: "file1\nfile2",
    isError: false,
    startedMs: Date.now() - 1000,
    doneMs: Date.now(),
  };

  // Reject bad role first, to lock the validation contract.
  try {
    await c.call("clawhq.chats.append", { chatId, role: "bogus", content: "" });
    fail("append with bad role should fail");
  } catch (e) {
    if (!String(e.message).includes("INVALID_REQUEST")) fail(`bad-role: ${e.message}`);
  }

  await c.call("clawhq.chats.append", {
    chatId, role: "tool", content: JSON.stringify(toolPayload),
  });

  // Read history back.
  const hist = await c.call("clawhq.chats.history", { chatId });
  const messages = hist.chat.messages;
  if (messages.length !== 1) fail(`expected 1 message, got ${messages.length}`);
  const m = messages[0];
  if (m.role !== "tool") fail(`role was ${m.role}, expected tool`);
  let parsed; try { parsed = JSON.parse(m.content); } catch { fail("content not JSON"); }
  if (parsed?.toolCallId !== toolPayload.toolCallId) fail(`toolCallId mismatch: ${parsed?.toolCallId}`);
  if (parsed?.name !== "Bash") fail(`name mismatch: ${parsed?.name}`);
  if (parsed?.result !== "file1\nfile2") fail(`result mismatch`);
  if (parsed?.isError !== false) fail(`isError mismatch`);

  await c.call("clawhq.chats.delete", { chatId });
  c.ws.close();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: role:"tool" persisted + round-tripped through chats.history\n`);
  process.exit(0);
}

main().catch((err) => { console.error("[test] fatal:", err); process.exit(2); });
