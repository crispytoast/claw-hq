#!/usr/bin/env node
/**
 * Phase C step 4 smoke test — /api/uploads + /uploads/:id round-trip,
 * and chat.send with an inline base64 image attachment.
 *
 *   1. POST a tiny PNG to /api/uploads, capture {id, url, mimeType, size}.
 *   2. GET /uploads/<id> and verify Content-Type + body bytes match.
 *   3. Open a tunnel WS, create a chat, fire chat.send with attachments[]
 *      containing the same image as base64. Assert OpenClaw responds with
 *      a final chat event (no validation error from chat.send).
 *   4. Cleanup the test chat.
 */
import { WebSocket } from "ws";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const PROJECT_SLUG = process.env.CLAWHQ_TEST_PROJECT ?? "the-interface-claw-hq";

// Smallest valid PNG: 1x1 transparent. Hand-rolled so we don't need a generator.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function log(label, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${label.padEnd(6)} ${msg}`);
}

let nextId = 1;
const requestId = (prefix) => `${prefix}-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function openClient(label) {
  const url = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(url);
  const pending = new Map();
  const eventListeners = new Set();
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  ws.on("open", () => log(label, "open"));
  ws.on("error", (err) => log(label, `err ${err.message}`));
  ws.on("message", (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
    const frame = env.frame;
    if (frame?.type === "event") {
      if (frame.event === "claw.session_ready") { readyResolve(); return; }
      for (const fn of eventListeners) fn(frame);
      return;
    }
    if (frame?.type === "res") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.payload);
      else entry.reject(new Error(`${frame.error?.code ?? "ERR"}: ${frame.error?.message ?? "(no message)"}`));
    }
  });
  const call = (method, params) => {
    const id = requestId(label);
    ws.send(JSON.stringify({
      kind: "frame", clientId: "self", direction: "client-to-agent",
      frame: { type: "req", id, method, params },
    }));
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
  };
  const onEvent = (fn) => { eventListeners.add(fn); return () => eventListeners.delete(fn); };
  return { ws, ready, call, onEvent, close: () => { try { ws.close(1000, "done"); } catch { /* noop */ } } };
}

async function main() {
  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // === Write the tiny PNG to /tmp so we can multipart-upload it. ===
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawhq-upload-"));
  const pngPath = path.join(tmpDir, "pixel.png");
  const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
  await fs.writeFile(pngPath, pngBytes);

  // === POST /api/uploads ===
  const formBoundary = `----clawhq${Math.random().toString(36).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${formBoundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`),
    pngBytes,
    Buffer.from(`\r\n--${formBoundary}--\r\n`),
  ]);
  const uploadRes = await fetch(`${RELAY}/api/uploads`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${formBoundary}` },
    body,
  });
  if (!uploadRes.ok) { fail(`upload returned ${uploadRes.status}`); }
  const upload = await uploadRes.json();
  log("UP", `id=${upload.id?.slice(0, 12)} size=${upload.size} mime=${upload.mimeType}`);
  if (upload.size !== pngBytes.length) fail(`upload size ${upload.size} vs ${pngBytes.length}`);
  if (upload.mimeType !== "image/png") fail(`upload mime ${upload.mimeType}`);
  if (typeof upload.url !== "string" || !upload.url.startsWith("/uploads/")) fail(`bad url ${upload.url}`);

  // === GET /uploads/<id> ===
  const getRes = await fetch(`${RELAY}${upload.url}`);
  if (!getRes.ok) fail(`GET returned ${getRes.status}`);
  if (getRes.headers.get("content-type") !== "image/png") {
    fail(`GET content-type ${getRes.headers.get("content-type")}`);
  }
  const got = Buffer.from(await getRes.arrayBuffer());
  if (Buffer.compare(got, pngBytes) !== 0) fail(`GET body mismatch`);

  // === chat.send with attachment ===
  const A = openClient("A");
  await A.ready;
  const created = await A.call("clawhq.chats.create", {
    projectSlug: PROJECT_SLUG, title: "phaseC4 attachment smoke",
  });
  const chatId = created.chat.id;
  log("A", `chatId=${chatId.slice(0, 8)}`);

  let chatFinalText = null;
  let chatResolve = null;
  const chatFinal = new Promise((r) => { chatResolve = r; });
  const wallTimeout = setTimeout(() => { if (chatResolve) chatResolve(); }, 25_000);
  A.onEvent((frame) => {
    if (frame.event !== "chat" || frame.payload?.state !== "final") return;
    const parts = frame.payload?.message?.content;
    if (Array.isArray(parts)) {
      const t = parts.find((p) => p && p.type === "text" && typeof p.text === "string");
      if (t) chatFinalText = t.text;
    }
    if (chatResolve) chatResolve();
  });

  await A.call("chat.send", {
    sessionKey: `agent:main:clawhq-${chatId.slice(0, 8)}`,
    message: "Reply with the single word ok if you can see an image.",
    attachments: [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "pixel.png",
        source: { type: "base64", media_type: "image/png", data: TINY_PNG_BASE64 },
      },
    ],
    idempotencyKey: `phaseC4-${Date.now()}`,
  });

  await chatFinal;
  clearTimeout(wallTimeout);
  log("A", `chat final="${(chatFinalText ?? "").slice(0, 60)}"`);
  if (!chatFinalText) fail("chat.send did not stream a final reply within 25s");

  // === Cleanup ===
  await A.call("clawhq.chats.delete", { chatId });
  A.close();
  await fs.rm(tmpDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: upload+serve+chat.send-with-attachment OK\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
