#!/usr/bin/env node
/**
 * Phase B step 3c smoke test — cross-device live feed for project chats.
 *
 * Strategy:
 *   - Open TWO WS clients on the relay (separate tunnel sessions = separate
 *     gateway operator clients).
 *   - Client A creates a chat, appends a user message.
 *   - Client B should observe a `clawhq.chat.message` event with the same
 *     chatId + role:"user" + content, even though B never called append.
 *   - Confirm the broadcast carries the persisted message id + projectSlug.
 *   - Clean up.
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

/**
 * Wrap a tunnel WS with: ready promise, request/response, event hook.
 */
function openClient(label) {
  const url = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(url);
  const pending = new Map();
  const eventListeners = new Set();
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  ws.on("open", () => log(label, `open ${url}`));
  ws.on("error", (err) => log(label, `err ${err.message}`));
  ws.on("message", (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
    const frame = env.frame;
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "event") {
      if (frame.event === "claw.session_ready") {
        log(label, `ready scopes=${(frame.payload?.scopes ?? []).join(",")}`);
        readyResolve();
        return;
      }
      if (frame.event === "relay.agent_offline") {
        log(label, "tunnel offline");
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

async function main() {
  const A = openClient("A");
  const B = openClient("B");
  await Promise.all([A.ready, B.ready]);

  // Set up B's event watcher BEFORE A sends, so we don't miss the broadcast.
  let observedEvent = null;
  let observedResolve = null;
  const observed = new Promise((resolve) => { observedResolve = resolve; });
  const observeTimeout = setTimeout(() => {
    if (!observedEvent) {
      log("B", "TIMEOUT waiting for plugin.clawhq.chat.message");
      observedResolve();
    }
  }, 5000);
  B.onEvent((frame) => {
    if (frame.event !== "plugin.clawhq.chat.message") return;
    observedEvent = frame.payload;
    log("B", `← plugin.clawhq.chat.message chatId=${frame.payload?.chatId} role=${frame.payload?.message?.role}`);
    clearTimeout(observeTimeout);
    observedResolve();
  });

  // A: create chat.
  const created = await A.call("clawhq.chats.create", {
    projectSlug: PROJECT_SLUG,
    title: "phaseB3c smoke",
  });
  const chatId = created.chat?.id;
  if (!chatId) throw new Error("no chat id");
  log("A", `chatId=${chatId}`);

  // A: append a user message — this should fire the broadcast.
  const appendResult = await A.call("clawhq.chats.append", {
    chatId,
    role: "user",
    content: "hello from A",
  });
  const sentMessageId = appendResult?.message?.id;
  log("A", `appended id=${sentMessageId}`);

  await observed;

  // Verify.
  let failures = 0;
  if (!observedEvent) {
    console.error("FAIL: client B never received clawhq.chat.message");
    failures++;
  } else {
    if (observedEvent.chatId !== chatId) {
      console.error(`FAIL: chatId mismatch ${observedEvent.chatId} vs ${chatId}`);
      failures++;
    }
    if (observedEvent.projectSlug !== PROJECT_SLUG) {
      console.error(`FAIL: projectSlug mismatch ${observedEvent.projectSlug} vs ${PROJECT_SLUG}`);
      failures++;
    }
    if (observedEvent.message?.role !== "user") {
      console.error(`FAIL: role ${observedEvent.message?.role}`);
      failures++;
    }
    if (observedEvent.message?.content !== "hello from A") {
      console.error(`FAIL: content "${observedEvent.message?.content}"`);
      failures++;
    }
    if (observedEvent.message?.id !== sentMessageId) {
      console.error(`FAIL: id mismatch ${observedEvent.message?.id} vs ${sentMessageId}`);
      failures++;
    }
    if (observedEvent.messageCount !== 1) {
      console.error(`FAIL: messageCount ${observedEvent.messageCount} (expected 1)`);
      failures++;
    }
  }

  // Cleanup.
  await A.call("clawhq.chats.delete", { chatId });
  A.close();
  B.close();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: B saw broadcast id=${sentMessageId} content="${observedEvent.message.content}"\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
