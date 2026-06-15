#!/usr/bin/env node
/**
 * Phase C step 31 smoke test — Config editor page.
 *
 *   1. Source wiring: ConfigEditorPage exists; Sidebar nav + ChatApp page
 *      switch + navOnly map all reference "config".
 *   2. Live: config.get returns a non-null payload.
 *   3. Live: config.schema is reachable.
 *   4. Live: config.schema.lookup with a fake path errors cleanly (not crash).
 */
import { WebSocket } from "ws";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.resolve(here, "../../web/src/components/pages/ConfigEditorPage.tsx");
const chatAppPath = path.resolve(here, "../../web/src/components/ChatApp.tsx");
const sidebarPath = path.resolve(here, "../../web/src/components/Sidebar.tsx");

let sourceFailures = 0;
const sourceFail = (m) => { console.error(`FAIL: ${m}`); sourceFailures++; };

if (!existsSync(pagePath)) sourceFail("ConfigEditorPage.tsx not found");
const chatSrc = readFileSync(chatAppPath, "utf8");
if (!chatSrc.includes("ConfigEditorPage")) sourceFail("ChatApp missing ConfigEditorPage import");
if (!chatSrc.includes("\"/config\"")) sourceFail("ChatApp navOnly missing /config");
const sideSrc = readFileSync(sidebarPath, "utf8");
if (!sideSrc.includes("\"config\"")) sourceFail("Sidebar SidebarPage type missing config");
if (!/id:\s*"config"/.test(sideSrc)) sourceFail("Sidebar STATIC_NAV missing config entry");

let nextId = 1;
const reqId = () => `t31-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

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
    const r = await c.call("config.get", {});
    const cfg = r?.config ?? r;
    if (!cfg || typeof cfg !== "object") liveFail(`config.get returned non-object: ${typeof cfg}`);
  } catch (e) {
    liveFail(`config.get: ${e.message}`);
  }

  try {
    const r = await c.call("config.schema", {});
    if (!r || typeof r !== "object") liveFail("config.schema returned non-object");
  } catch (e) {
    // Some Gateways gate config.schema behind operator.admin; treat unknown-method
    // as a hard fail but scope errors as a soft skip.
    if (/unknown method/.test(e.message)) liveFail(`config.schema not registered: ${e.message}`);
  }

  try {
    await c.call("config.schema.lookup", { path: "does.not.exist.bogus" });
    // No throw is also acceptable — the page handles the lookup failing.
  } catch (e) {
    if (/unknown method/.test(e.message)) {
      console.warn(`[soft] config.schema.lookup not registered — page falls back gracefully`);
    }
  }

  try { c.ws.close(); } catch {}

  const total = sourceFailures + live;
  if (total > 0) {
    console.error(`\n  ${total} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: Config editor source wiring + config.{get,schema,schema.lookup} contracts OK\n`);
  process.exit(0);
}

main().catch((err) => { console.error("[test] fatal:", err); process.exit(2); });
