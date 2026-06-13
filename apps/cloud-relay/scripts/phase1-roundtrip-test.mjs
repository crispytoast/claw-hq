#!/usr/bin/env node
/**
 * Phase 1 end-to-end round-trip test.
 *
 * Mimics what the web stub does:
 *   1. Connect to relay as a client.
 *   2. Wait for the OpenClaw connect.challenge event (relayed from the local Gateway via tunnel).
 *   3. Send a `connect` request with the shared-secret token + operator scopes.
 *   4. Verify hello-ok with protocol=4.
 *   5. (Optional, --send-chat) Issue `chat.send` and collect events for N seconds.
 *
 * Exits 0 on success, non-zero on failure. Prints a tagged log so it's
 * trivially diffable when something breaks.
 */
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(resolve(HERE, "..", "..", "..", "apps", "tunnel-agent", "config.json"), "utf-8"));
const RELAY_CLIENT_URL = "ws://localhost:3838/client?tenant=demo";

const args = new Set(process.argv.slice(2));
const SEND_CHAT = args.has("--send-chat");
const CHAT_WAIT_MS = SEND_CHAT ? 15_000 : 0;

let nextId = 1;
const requestId = () => `t-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function log(kind, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${kind.padEnd(6)} ${msg}`);
}

const ws = new WebSocket(RELAY_CLIENT_URL);
let connectId = null;
let helloOkSeen = false;
let challengeSeen = false;
let chatRunId = null;
let chatFinalText = null;
let timedOut = false;

const failed = (reason) => {
  log("FAIL", reason);
  process.exitCode = 1;
  try { ws.close(); } catch {}
};

const wallClockTimeout = setTimeout(() => {
  timedOut = true;
  failed(`hard timeout after ${CHAT_WAIT_MS + 8_000}ms`);
}, CHAT_WAIT_MS + 8_000);

function sendFrame(frame) {
  log("SEND", `${frame.method ?? frame.type} ${JSON.stringify(frame).slice(0, 140)}`);
  // clientId is overwritten by the relay with the connection's clientId; placeholder is fine.
  ws.send(JSON.stringify({ kind: "frame", clientId: "self", direction: "client-to-agent", frame }));
}

ws.on("open", () => {
  log("OPEN", `relay client ${RELAY_CLIENT_URL}`);
});

ws.on("close", (code, reason) => {
  log("CLOSE", `ws code=${code} reason=${reason.toString() || "(none)"}`);
  if (!helloOkSeen && !timedOut) failed("ws closed before hello-ok");
  clearTimeout(wallClockTimeout);
  // Wait a tick to let any final logs flush.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
});

ws.on("error", (err) => log("ERR", `ws ${err.message}`));

ws.on("message", (raw) => {
  let envelope;
  try { envelope = JSON.parse(raw.toString()); } catch { return; }
  if (envelope.kind !== "frame" || envelope.direction !== "agent-to-client") return;
  const frame = envelope.frame;
  if (!frame || typeof frame !== "object") return;

  if (frame.type === "event" && frame.event === "connect.challenge") {
    challengeSeen = true;
    log("RECV", `connect.challenge nonce=${(frame.payload?.nonce ?? "").slice(0, 8)}…`);
    connectId = requestId();
    sendFrame({
      type: "req",
      id: connectId,
      method: "connect",
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        // "gateway-client" + "backend" is the trusted-loopback path the docs
        // recommend for shared-secret callers that aren't a device-paired CLI.
        client: { id: "gateway-client", version: "0.0.1", platform: "linux", mode: "backend" },
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        caps: [],
        commands: [],
        permissions: {},
        auth: { token: CONFIG.gatewayToken },
        locale: "en-US",
        userAgent: "claw-hq-phase1-test/0.0.1",
      },
    });
    return;
  }

  if (frame.type === "res" && frame.id === connectId) {
    if (!frame.ok) {
      failed(`connect rejected: ${frame.error?.message ?? "unknown"} ${JSON.stringify(frame.error?.details ?? {})}`);
      return;
    }
    helloOkSeen = true;
    const p = frame.payload ?? {};
    log("OK", `hello-ok protocol=${p.protocol} role=${p.auth?.role} scopes=${(p.auth?.scopes ?? []).join(",")}`);
    if (!SEND_CHAT) {
      log("DONE", "connect round-trip verified; closing");
      try { ws.close(1000, "phase1-test complete"); } catch {}
      return;
    }
    // Issue chat.send.
    chatRunId = requestId();
    sendFrame({
      type: "req",
      id: chatRunId,
      method: "chat.send",
      params: {
        sessionKey: "agent:main:main",
        message: "Reply with just the single word: ok",
        idempotencyKey: `claw-hq-phase1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    log("WAIT", `chat sent; collecting events for ${CHAT_WAIT_MS}ms`);
    setTimeout(() => {
      if (chatFinalText) {
        log("DONE", `chat round-trip: final="${chatFinalText}"`);
      } else {
        failed(`no final chat reply within ${CHAT_WAIT_MS}ms`);
      }
      try { ws.close(1000, "phase1-test complete"); } catch {}
    }, CHAT_WAIT_MS);
    return;
  }

  if (frame.type === "event") {
    const payloadStr = JSON.stringify(frame.payload ?? {});
    log("EV", `${frame.event} ${payloadStr.slice(0, 160)}${payloadStr.length > 160 ? "…" : ""}`);
    // The terminal chat event has state="final" with the assistant content as
    // an array of typed parts. Grab the first text part.
    if (frame.event === "chat" && frame.payload?.state === "final") {
      const parts = frame.payload?.message?.content;
      if (Array.isArray(parts)) {
        const textPart = parts.find((p) => p && p.type === "text" && typeof p.text === "string");
        if (textPart) chatFinalText = textPart.text;
      }
      // Some shapes carry a flat string here too.
      if (!chatFinalText && typeof frame.payload?.message === "string") {
        chatFinalText = frame.payload.message;
      }
      if (chatFinalText) {
        log("DONE", `chat final received: "${chatFinalText}"`);
        try { ws.close(1000, "phase1-test complete"); } catch {}
      }
    }
    return;
  }

  if (frame.type === "res") {
    log("RES", `id=${frame.id} ok=${frame.ok} ${JSON.stringify(frame.payload ?? frame.error ?? {}).slice(0, 160)}`);
    if (frame.id === chatRunId && frame.ok && typeof frame.payload?.text === "string") {
      chatFinalText = frame.payload.text;
    }
    return;
  }
});
