#!/usr/bin/env node
/**
 * Phase C step 13 smoke test — clawhq.memory.* methods accept an omitted
 * projectSlug and operate on <workspaceRoot>/memory/.
 *
 *   1. put a file with projectSlug omitted; file lands at
 *      <workspaceRoot>/memory/<name>.
 *   2. list returns it; get returns content.
 *   3. delete removes it.
 *   4. Both flavors (project AND workspace) still work independently —
 *      project-level write doesn't pollute workspace dir and vice versa.
 *   5. Path-traversal guard still rejects ../escape names in workspace mode.
 *   6. Cleanup.
 */
import { WebSocket } from "ws";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const WORKSPACE = process.env.CLAWHQ_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");
const WORKSPACE_MEMORY_DIR = path.join(WORKSPACE, "memory");
const PROJECT_SLUG = "clawhq-smoke-ws-mem";
const PROJECT_DIR = path.join(WORKSPACE, "projects", PROJECT_SLUG);
const PROJECT_MEMORY_DIR = path.join(PROJECT_DIR, "memory");
const FILENAME = `phaseC13-${Date.now().toString(36)}.md`;
const PROJECT_FILENAME = `phaseC13p-${Date.now().toString(36)}.md`;

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

async function cleanup() {
  await fs.rm(path.join(WORKSPACE_MEMORY_DIR, FILENAME), { force: true });
  await fs.rm(PROJECT_DIR, { recursive: true, force: true });
}

async function main() {
  await fs.mkdir(PROJECT_DIR, { recursive: true });
  const c = openClient();
  await c.ready;

  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // === put workspace-level (projectSlug omitted) ===
  const wsPut = await c.call("clawhq.memory.put", {
    name: FILENAME,
    content: "workspace memory body\n",
  });
  if (wsPut.projectSlug !== null) fail(`ws put projectSlug=${wsPut.projectSlug}`);
  if (wsPut.file?.created !== true) fail("ws put.created");

  const onDisk = await fs.readFile(path.join(WORKSPACE_MEMORY_DIR, FILENAME), "utf8");
  if (onDisk !== "workspace memory body\n") fail("ws disk content mismatch");

  // === list workspace-level ===
  const wsList = await c.call("clawhq.memory.list", {});
  if (wsList.projectSlug !== null) fail(`ws list projectSlug=${wsList.projectSlug}`);
  if (!wsList.files.some((f) => f.name === FILENAME)) fail("ws list missing file");

  // === get workspace-level ===
  const wsGet = await c.call("clawhq.memory.get", { name: FILENAME });
  if (wsGet.file?.content !== "workspace memory body\n") fail("ws get content");

  // === project-level still works independently ===
  await c.call("clawhq.memory.put", {
    projectSlug: PROJECT_SLUG, name: PROJECT_FILENAME, content: "proj body\n",
  });
  const projList = await c.call("clawhq.memory.list", { projectSlug: PROJECT_SLUG });
  if (!projList.files.some((f) => f.name === PROJECT_FILENAME)) fail("project list missing");
  if (projList.files.some((f) => f.name === FILENAME)) fail("project list leaked workspace file");

  const wsListAfterProj = await c.call("clawhq.memory.list", {});
  if (wsListAfterProj.files.some((f) => f.name === PROJECT_FILENAME)) fail("workspace list leaked project file");

  // === traversal still rejected workspace-mode ===
  try {
    await c.call("clawhq.memory.put", { name: "../escape.md", content: "no" });
    fail("traversal should fail");
  } catch (e) {
    if (!String(e.message).includes("INVALID_REQUEST")) fail(`traversal: ${e.message}`);
  }

  // === delete workspace ===
  const del = await c.call("clawhq.memory.delete", { name: FILENAME });
  if (del.deleted !== true) fail("delete result");
  try {
    await fs.access(path.join(WORKSPACE_MEMORY_DIR, FILENAME));
    fail("workspace file still exists after delete");
  } catch { /* expected */ }

  c.ws.close();
  await cleanup();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: workspace + project memory modes work independently with the same RPC surface\n`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[test] fatal:", err);
  try { await cleanup(); } catch { /* noop */ }
  process.exit(2);
});
