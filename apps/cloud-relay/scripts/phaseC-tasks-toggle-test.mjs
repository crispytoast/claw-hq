#!/usr/bin/env node
/**
 * Phase C step 1 smoke test — clawhq.tasks.toggle + broadcast.
 *
 * Creates a disposable project under workspace/projects/clawhq-smoke-test/
 * with a known TASKS.md, then:
 *   1. Two WS clients A + B.
 *   2. A toggles checkbox index 1 → true.
 *   3. B observes plugin.clawhq.task.toggled with the new content + counts.
 *   4. A toggles index 1 → false; B sees it again.
 *   5. Disk content matches the broadcast each time.
 *   6. NOT_FOUND on invalid project, INVALID_REQUEST on bad params, NOT_FOUND
 *      when lineIndex points past the last checkbox.
 *   7. Cleanup: remove the disposable project directory.
 */
import { WebSocket } from "ws";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const WORKSPACE = process.env.CLAWHQ_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");
const PROJECT_SLUG = "clawhq-smoke-test";
const PROJECT_DIR = path.join(WORKSPACE, "projects", PROJECT_SLUG);
const TASKS_PATH = path.join(PROJECT_DIR, "TASKS.md");

const INITIAL_TASKS = `# Smoke test — Tasks

## Claude
- [ ] First task
- [ ] Second task
- [x] Already done
- [ ] Fourth task
`;

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
  await fs.writeFile(TASKS_PATH, INITIAL_TASKS, "utf8");
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

  // === Toggle index 1 → true ===
  const evt1 = expectEvent(B, "plugin.clawhq.task.toggled");
  const res1 = await A.call("clawhq.tasks.toggle", { projectSlug: PROJECT_SLUG, lineIndex: 1, checked: true });
  const broadcast1 = await evt1;
  log("B", `← toggled lineIndex=${broadcast1?.lineIndex} checked=${broadcast1?.checked} ${broadcast1?.checkedCount}/${broadcast1?.totalCount}`);
  if (res1.totalCount !== 4) fail(`response totalCount ${res1.totalCount} (expected 4)`);
  if (res1.checkedCount !== 2) fail(`response checkedCount ${res1.checkedCount} (expected 2)`);
  if (broadcast1.projectSlug !== PROJECT_SLUG) fail("broadcast projectSlug mismatch");
  if (broadcast1.subprojectSlug !== null) fail(`broadcast subprojectSlug ${broadcast1.subprojectSlug}`);
  if (broadcast1.lineIndex !== 1) fail(`broadcast lineIndex ${broadcast1.lineIndex}`);
  if (broadcast1.checked !== true) fail("broadcast checked");
  if (broadcast1.totalCount !== 4 || broadcast1.checkedCount !== 2) fail("broadcast counts wrong");
  if (broadcast1.content !== res1.content) fail("broadcast/response content diverged");

  const onDisk1 = await fs.readFile(TASKS_PATH, "utf8");
  if (onDisk1 !== broadcast1.content) fail("disk content doesn't match broadcast");
  if (!onDisk1.includes("- [x] Second task")) fail("Second task not flipped to checked");

  // === Toggle index 1 → false ===
  const evt2 = expectEvent(B, "plugin.clawhq.task.toggled");
  const res2 = await A.call("clawhq.tasks.toggle", { projectSlug: PROJECT_SLUG, lineIndex: 1, checked: false });
  const broadcast2 = await evt2;
  log("B", `← toggled lineIndex=${broadcast2?.lineIndex} checked=${broadcast2?.checked} ${broadcast2?.checkedCount}/${broadcast2?.totalCount}`);
  if (res2.checkedCount !== 1) fail(`response checkedCount ${res2.checkedCount} (expected 1)`);
  if (broadcast2.checked !== false) fail("second broadcast checked");
  const onDisk2 = await fs.readFile(TASKS_PATH, "utf8");
  if (!onDisk2.includes("- [ ] Second task")) fail("Second task not flipped back to unchecked");

  // === NOT_FOUND on unknown project ===
  try {
    await A.call("clawhq.tasks.toggle", { projectSlug: "does-not-exist", lineIndex: 0, checked: true });
    fail("toggle on unknown project should fail");
  } catch (e) {
    if (!String(e.message).includes("NOT_FOUND")) fail(`unknown project: unexpected error ${e.message}`);
  }

  // === INVALID_REQUEST on missing lineIndex ===
  try {
    await A.call("clawhq.tasks.toggle", { projectSlug: PROJECT_SLUG, checked: true });
    fail("toggle missing lineIndex should fail");
  } catch (e) {
    if (!String(e.message).includes("INVALID_REQUEST")) fail(`missing lineIndex: ${e.message}`);
  }

  // === NOT_FOUND on lineIndex past end ===
  try {
    await A.call("clawhq.tasks.toggle", { projectSlug: PROJECT_SLUG, lineIndex: 99, checked: true });
    fail("toggle out-of-range lineIndex should fail");
  } catch (e) {
    if (!String(e.message).includes("NOT_FOUND")) fail(`oob: ${e.message}`);
  }

  A.close();
  B.close();

  await teardownProject();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: tasks.toggle wrote disk + broadcast across both clients\n`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[test] fatal:", err);
  try { await teardownProject(); } catch { /* noop */ }
  process.exit(2);
});
