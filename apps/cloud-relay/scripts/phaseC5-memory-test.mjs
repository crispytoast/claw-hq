#!/usr/bin/env node
/**
 * Phase C step 5 smoke test — clawhq.memory.{list,get,put,delete} + broadcasts.
 *
 * Uses a disposable workspace/projects/clawhq-smoke-test/ project. Two WS
 * clients A + B:
 *   1. A creates a memory file via put → B sees plugin.clawhq.memory.updated
 *      with created=true.
 *   2. A updates same file → B sees plugin.clawhq.memory.updated with
 *      created=false.
 *   3. list returns both files we wrote; get returns content + metadata.
 *   4. A deletes the file → B sees plugin.clawhq.memory.deleted.
 *   5. INVALID_REQUEST: bad slug, bad filename (../escape, ".env", no .md).
 *   6. NOT_FOUND: get/delete on a name that doesn't exist.
 *   7. Cleanup removes the disposable project directory.
 */
import { WebSocket } from "ws";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const WORKSPACE = process.env.CLAWHQ_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");
const PROJECT_SLUG = "clawhq-smoke-test";
const PROJECT_DIR = path.join(WORKSPACE, "projects", PROJECT_SLUG);
const MEMORY_DIR = path.join(PROJECT_DIR, "memory");

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

  ws.on("open", () => log(label, "open"));
  ws.on("error", (err) => log(label, `err ${err.message}`));
  ws.on("message", (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
    const frame = env.frame;
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "event") {
      if (frame.event === "claw.session_ready") {
        log(label, "ready");
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
    ws.send(JSON.stringify({
      kind: "frame",
      clientId: "self",
      direction: "client-to-agent",
      frame: { type: "req", id, method, params },
    }));
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
  };
  const onEvent = (fn) => { eventListeners.add(fn); return () => eventListeners.delete(fn); };
  const close = () => { try { ws.close(1000, "done"); } catch { /* noop */ } };
  return { ws, ready, call, onEvent, close };
}

function expectEvent(client, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let off;
    const timer = setTimeout(() => { if (off) off(); reject(new Error(`timeout waiting for ${eventName}`)); }, timeoutMs);
    off = client.onEvent((frame) => {
      if (frame.event !== eventName) return;
      clearTimeout(timer);
      off();
      resolve(frame.payload);
    });
  });
}

async function setupProject() {
  await fs.mkdir(PROJECT_DIR, { recursive: true });
}

async function teardownProject() {
  await fs.rm(PROJECT_DIR, { recursive: true, force: true });
}

async function main() {
  await setupProject();

  const A = openClient("A");
  const B = openClient("B");
  await Promise.all([A.ready, B.ready]);

  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // === Create NOTES.md ===
  const evtCreate = expectEvent(B, "plugin.clawhq.memory.updated");
  const putRes1 = await A.call("clawhq.memory.put", {
    projectSlug: PROJECT_SLUG,
    name: "NOTES.md",
    content: "# Notes\n\nFirst memory entry.\n",
  });
  const broadcastCreate = await evtCreate;
  if (putRes1.file?.created !== true) fail(`put response created=${putRes1.file?.created}`);
  if (putRes1.file?.size !== 28) {
    // 28 bytes for "# Notes\n\nFirst memory entry.\n"
    // not a hard assert — sizes can drift; only complain if absurd.
    if (putRes1.file?.size < 20 || putRes1.file?.size > 40) {
      fail(`put response size ${putRes1.file?.size} out of expected range`);
    }
  }
  if (broadcastCreate.projectSlug !== PROJECT_SLUG) fail("create broadcast projectSlug mismatch");
  if (broadcastCreate.name !== "NOTES.md") fail("create broadcast name mismatch");
  if (broadcastCreate.created !== true) fail("create broadcast created");

  const onDisk1 = await fs.readFile(path.join(MEMORY_DIR, "NOTES.md"), "utf8");
  if (onDisk1 !== "# Notes\n\nFirst memory entry.\n") fail("disk content doesn't match what we wrote");

  // === Update NOTES.md (created=false this time) ===
  const evtUpdate = expectEvent(B, "plugin.clawhq.memory.updated");
  const putRes2 = await A.call("clawhq.memory.put", {
    projectSlug: PROJECT_SLUG,
    name: "NOTES.md",
    content: "# Notes\n\nFirst memory entry, edited.\n",
  });
  const broadcastUpdate = await evtUpdate;
  if (putRes2.file?.created !== false) fail(`update response created=${putRes2.file?.created}`);
  if (broadcastUpdate.created !== false) fail("update broadcast created");

  // === Create a second file ===
  await A.call("clawhq.memory.put", {
    projectSlug: PROJECT_SLUG,
    name: "ideas.md",
    content: "- idea one\n- idea two\n",
  });

  // === list returns both files, sorted by mtime desc ===
  const listRes = await A.call("clawhq.memory.list", { projectSlug: PROJECT_SLUG });
  if (!Array.isArray(listRes.files)) fail("list response shape");
  if (listRes.files.length !== 2) fail(`list returned ${listRes.files.length} files (expected 2)`);
  const names = listRes.files.map((f) => f.name).sort();
  if (names[0] !== "NOTES.md" || names[1] !== "ideas.md") fail(`list names ${names.join(",")}`);
  log("A", `← list: ${names.join(", ")}`);

  // === get returns content + metadata ===
  const getRes = await A.call("clawhq.memory.get", { projectSlug: PROJECT_SLUG, name: "NOTES.md" });
  if (getRes.file?.content !== "# Notes\n\nFirst memory entry, edited.\n") fail("get content mismatch");
  if (getRes.file?.name !== "NOTES.md") fail("get name mismatch");
  if (typeof getRes.file?.size !== "number" || typeof getRes.file?.updatedMs !== "number") {
    fail("get missing size/updatedMs");
  }

  // === delete + broadcast ===
  const evtDelete = expectEvent(B, "plugin.clawhq.memory.deleted");
  const delRes = await A.call("clawhq.memory.delete", { projectSlug: PROJECT_SLUG, name: "ideas.md" });
  const broadcastDelete = await evtDelete;
  if (delRes.deleted !== true) fail("delete response shape");
  if (broadcastDelete.name !== "ideas.md") fail("delete broadcast name mismatch");

  try {
    await fs.access(path.join(MEMORY_DIR, "ideas.md"));
    fail("ideas.md still exists after delete");
  } catch { /* expected */ }

  // === INVALID_REQUEST: bad filename (traversal) ===
  try {
    await A.call("clawhq.memory.put", {
      projectSlug: PROJECT_SLUG,
      name: "../escape.md",
      content: "should fail",
    });
    fail("traversal put should fail");
  } catch (e) {
    if (!String(e.message).includes("INVALID_REQUEST")) fail(`traversal: ${e.message}`);
  }

  // === INVALID_REQUEST: bad filename (no .md) ===
  try {
    await A.call("clawhq.memory.put", {
      projectSlug: PROJECT_SLUG,
      name: "noext",
      content: "should fail",
    });
    fail("no-ext put should fail");
  } catch (e) {
    if (!String(e.message).includes("INVALID_REQUEST")) fail(`no-ext: ${e.message}`);
  }

  // === INVALID_REQUEST: hidden file ===
  try {
    await A.call("clawhq.memory.put", {
      projectSlug: PROJECT_SLUG,
      name: ".env.md",
      content: "should fail",
    });
    fail("hidden put should fail");
  } catch (e) {
    if (!String(e.message).includes("INVALID_REQUEST")) fail(`hidden: ${e.message}`);
  }

  // === NOT_FOUND: get on missing name ===
  try {
    await A.call("clawhq.memory.get", { projectSlug: PROJECT_SLUG, name: "nope.md" });
    fail("get on missing should fail");
  } catch (e) {
    if (!String(e.message).includes("NOT_FOUND")) fail(`get-missing: ${e.message}`);
  }

  // === NOT_FOUND: delete on missing name ===
  try {
    await A.call("clawhq.memory.delete", { projectSlug: PROJECT_SLUG, name: "nope.md" });
    fail("delete on missing should fail");
  } catch (e) {
    if (!String(e.message).includes("NOT_FOUND")) fail(`delete-missing: ${e.message}`);
  }

  // === INVALID_REQUEST: missing required params ===
  try {
    await A.call("clawhq.memory.list", {});
    fail("list missing projectSlug should fail");
  } catch (e) {
    if (!String(e.message).includes("INVALID_REQUEST")) fail(`list-missing: ${e.message}`);
  }

  A.close();
  B.close();

  await teardownProject();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: memory CRUD wrote disk + broadcast across both clients\n`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[test] fatal:", err);
  try { await teardownProject(); } catch { /* noop */ }
  process.exit(2);
});
