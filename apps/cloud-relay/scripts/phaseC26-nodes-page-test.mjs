#!/usr/bin/env node
/**
 * Phase C step 26 smoke test — Nodes page.
 *
 * Pure plumbing check: the page calls native OpenClaw Gateway methods
 * (`node.list`, `node.pair.list`, `node.pair.approve`, etc.) — no plugin code
 * to install on the host. We verify:
 *
 *   1. node.list resolves and returns an array under one of {nodes, rows, items}.
 *   2. node.pair.list resolves and returns an array under one of {requests, pending, items}.
 *   3. node.pair.reject without a requestId returns an error (locks the contract).
 *
 * If the relay isn't running we skip the live checks — the source-level check
 * for the page file's existence still runs.
 */
import { WebSocket } from "ws";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";

const here = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.resolve(here, "../../web/src/components/pages/NodesPage.tsx");
const chatAppPath = path.resolve(here, "../../web/src/components/ChatApp.tsx");
const sidebarPath = path.resolve(here, "../../web/src/components/Sidebar.tsx");

let sourceFailures = 0;
const sourceFail = (m) => { console.error(`FAIL: ${m}`); sourceFailures++; };

if (!existsSync(pagePath)) sourceFail("NodesPage.tsx not found");
const chatAppSrc = readFileSync(chatAppPath, "utf8");
if (!chatAppSrc.includes("NodesPage")) sourceFail("ChatApp does not import NodesPage");
if (!chatAppSrc.includes("\"/nodes\"")) sourceFail("ChatApp navOnly map missing /nodes");
const sidebarSrc = readFileSync(sidebarPath, "utf8");
if (!sidebarSrc.includes("\"nodes\"")) sourceFail("Sidebar SidebarPage type missing \"nodes\"");
if (!/id:\s*"nodes"/.test(sidebarSrc)) sourceFail("Sidebar STATIC_NAV missing nodes entry");

let nextId = 1;
const reqId = () => `t26-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

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
    const r = await c.call("node.list", {});
    const arr = r?.nodes ?? r?.rows ?? r?.items ?? null;
    if (!Array.isArray(arr)) liveFail(`node.list shape: ${JSON.stringify(r).slice(0, 120)}`);
  } catch (e) {
    liveFail(`node.list: ${e.message}`);
  }

  try {
    const r = await c.call("node.pair.list", {});
    const arr = r?.requests ?? r?.pending ?? r?.items ?? null;
    if (!Array.isArray(arr)) liveFail(`node.pair.list shape: ${JSON.stringify(r).slice(0, 120)}`);
  } catch (e) {
    liveFail(`node.pair.list: ${e.message}`);
  }

  try {
    await c.call("node.pair.reject", {});
    liveFail("node.pair.reject with empty params should fail");
  } catch (e) {
    if (!/(INVALID|requestId|NOT_FOUND|required)/i.test(e.message)) {
      liveFail(`node.pair.reject(empty) unexpected: ${e.message}`);
    }
  }

  try { c.ws.close(); } catch {}

  const total = sourceFailures + live;
  if (total > 0) {
    console.error(`\n  ${total} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: Nodes page source wiring + node.{list,pair.list,pair.reject} contracts OK\n`);
  process.exit(0);
}

main().catch((err) => { console.error("[test] fatal:", err); process.exit(2); });
