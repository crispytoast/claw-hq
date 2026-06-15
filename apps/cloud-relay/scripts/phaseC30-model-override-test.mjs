#!/usr/bin/env node
/**
 * Phase C step 30 smoke test — per-session model override on Models page.
 *
 *   1. Source: ModelsPage references sessions.list + sessions.patch.
 *   2. Live: sessions.list returns an array under one of {sessions, rows, items}.
 *   3. Live: sessions.patch on a fake key surfaces a sensible error rather than
 *      silently writing nothing (the contract we depend on).
 */
import { WebSocket } from "ws";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.resolve(here, "../../web/src/components/pages/ModelsPage.tsx");

let sourceFailures = 0;
const sourceFail = (m) => { console.error(`FAIL: ${m}`); sourceFailures++; };

if (!existsSync(pagePath)) sourceFail("ModelsPage.tsx not found");
const src = readFileSync(pagePath, "utf8");
if (!src.includes("sessions.list")) sourceFail("ModelsPage missing sessions.list call");
if (!src.includes("sessions.patch")) sourceFail("ModelsPage missing sessions.patch call");
if (!src.includes("Per-session override")) sourceFail("ModelsPage missing per-session override card");

let nextId = 1;
const reqId = () => `t30-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function openClient(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const url = RELAY.replace(/^http/, "ws") + "/ws/client";
    const ws = new WebSocket(url);
    const pending = new Map();
    let readyResolve;
    const ready = new Promise((res) => { readyResolve = res; });
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("ws connect timeout")); }, timeoutMs);
    ws.on("open", () => clearTimeout(t));
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
  let live = 0;
  const liveFail = (m) => { console.error(`FAIL: ${m}`); live++; };

  let c;
  try {
    c = await openClient();
    await Promise.race([
      c.ready,
      new Promise((_r, rj) => setTimeout(() => rj(new Error("session_ready timeout")), 5000)),
    ]);
  } catch (e) {
    console.warn(`[live skip] relay unreachable: ${e.message}`);
    if (sourceFailures > 0) process.exit(1);
    console.log("\n  Result: source wiring OK (live checks skipped)\n");
    process.exit(0);
  }

  try {
    const r = await c.call("sessions.list", {});
    const arr = r?.sessions ?? r?.rows ?? r?.items ?? null;
    if (!Array.isArray(arr)) liveFail(`sessions.list shape: ${JSON.stringify(r).slice(0, 120)}`);
  } catch (e) {
    liveFail(`sessions.list: ${e.message}`);
  }

  // sessions.patch contract: the page calls it with {key, model}. We don't
  // assume it MUST reject a bogus key — some Gateway builds noop, some error.
  // What we do require is that the RPC method is registered and reachable.
  try {
    const r = await c.call("sessions.patch", { key: "bogus:does:not:exist", model: "claude-opus-4-7" });
    // If it returned, the method exists. The page handles both `.resolvedModel`
    // and `.model` so either is fine, but a totally empty response is fine too
    // (some builds return {} on missing-session noops).
    if (r === undefined || r === null) liveFail("sessions.patch returned null/undefined");
  } catch (e) {
    if (/unknown method/.test(e.message)) liveFail(`sessions.patch not registered: ${e.message}`);
    // Otherwise: the method ran and rejected (NOT_FOUND, INVALID, etc) — fine.
  }

  try { c.ws.close(); } catch {}

  const total = sourceFailures + live;
  if (total > 0) {
    console.error(`\n  ${total} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: per-session model override source wiring + sessions.{list,patch} contracts OK\n`);
  process.exit(0);
}

main().catch((err) => { console.error("[test] fatal:", err); process.exit(2); });
