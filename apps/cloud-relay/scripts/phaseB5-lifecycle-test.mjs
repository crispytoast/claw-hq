#!/usr/bin/env node
/**
 * Phase B step 5 smoke test — chat lifecycle broadcasts.
 *
 *   - Two WS clients (A acts, B observes).
 *   - A creates a chat → B should see plugin.clawhq.chat.created.
 *   - A renames it → B should see plugin.clawhq.chat.renamed (title updated).
 *   - A deletes it → B should see plugin.clawhq.chat.deleted.
 *
 * Exits 0 on success, non-zero otherwise.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const PROJECT_SLUG = process.env.CLAWHQ_TEST_PROJECT ?? "the-interface-claw-hq";

function log(label, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${label.padEnd(8)} ${msg}`);
}

let nextId = 1;
const requestId = (prefix) => `${prefix}-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function openClient(label) {
  const url = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(url);
  const pending = new Map();
  const eventListeners = new Set();
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  ws.on("open", () => log(label, `open`));
  ws.on("error", (err) => log(label, `err ${err.message}`));
  ws.on("message", (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
    const frame = env.frame;
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "event") {
      if (frame.event === "claw.session_ready") {
        log(label, `ready`);
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
    const id = requestId(label);
    log(label, `→ ${method}`);
    ws.send(
      JSON.stringify({
        kind: "frame",
        clientId: "self",
        direction: "client-to-agent",
        frame: { type: "req", id, method, params },
      }),
    );
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const onEvent = (fn) => {
    eventListeners.add(fn);
    return () => eventListeners.delete(fn);
  };

  return { ws, ready, call, onEvent, close: () => { try { ws.close(1000, "done"); } catch { /* noop */ } } };
}

function expectEvent(client, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let off;
    const timer = setTimeout(() => {
      if (off) off();
      reject(new Error(`timeout waiting for ${eventName}`));
    }, timeoutMs);
    off = client.onEvent((frame) => {
      if (frame.event !== eventName) return;
      clearTimeout(timer);
      off();
      resolve(frame.payload);
    });
  });
}

async function main() {
  const A = openClient("A");
  const B = openClient("B");
  await Promise.all([A.ready, B.ready]);

  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // === Create ===
  const createdEvent = expectEvent(B, "plugin.clawhq.chat.created");
  const created = await A.call("clawhq.chats.create", {
    projectSlug: PROJECT_SLUG,
    title: "phaseB5 smoke original",
  });
  const chatId = created.chat?.id;
  if (!chatId) throw new Error("no chat id from create");
  const createdPayload = await createdEvent;
  log("B", `← created chatId=${createdPayload?.chat?.id} title="${createdPayload?.chat?.title}"`);
  if (createdPayload?.chat?.id !== chatId) fail(`create chatId mismatch`);
  if (createdPayload?.chat?.projectSlug !== PROJECT_SLUG) fail(`create projectSlug mismatch`);
  if (createdPayload?.chat?.title !== "phaseB5 smoke original") fail(`create title mismatch`);
  if (createdPayload?.chat?.messageCount !== 0) fail(`create messageCount ${createdPayload?.chat?.messageCount}`);

  // === Rename ===
  const renamedEvent = expectEvent(B, "plugin.clawhq.chat.renamed");
  await A.call("clawhq.chats.rename", { chatId, title: "phaseB5 smoke renamed" });
  const renamedPayload = await renamedEvent;
  log("B", `← renamed chatId=${renamedPayload?.chatId} title="${renamedPayload?.title}"`);
  if (renamedPayload?.chatId !== chatId) fail(`rename chatId mismatch`);
  if (renamedPayload?.title !== "phaseB5 smoke renamed") fail(`rename title mismatch`);
  if (renamedPayload?.projectSlug !== PROJECT_SLUG) fail(`rename projectSlug mismatch`);

  // Verify the rename persisted via history.
  const history = await A.call("clawhq.chats.history", { chatId });
  if (history.chat?.title !== "phaseB5 smoke renamed") fail(`history title still "${history.chat?.title}"`);

  // === Delete ===
  const deletedEvent = expectEvent(B, "plugin.clawhq.chat.deleted");
  await A.call("clawhq.chats.delete", { chatId });
  const deletedPayload = await deletedEvent;
  log("B", `← deleted chatId=${deletedPayload?.chatId}`);
  if (deletedPayload?.chatId !== chatId) fail(`delete chatId mismatch`);
  if (deletedPayload?.projectSlug !== PROJECT_SLUG) fail(`delete projectSlug mismatch`);

  // Verify the chat is actually gone.
  try {
    await A.call("clawhq.chats.history", { chatId });
    fail("chats.history should fail after delete");
  } catch (e) {
    if (!String(e.message).includes("NOT_FOUND")) fail(`unexpected error after delete: ${e.message}`);
  }

  A.close();
  B.close();
  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: create + rename + delete broadcasts all observed\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
