#!/usr/bin/env node
/**
 * Phase C step 2 smoke test — clawhq.subprojects.get + subproject-scoped tasks.toggle.
 *
 * Creates a disposable project + subproject layout, then:
 *   1. clawhq.subprojects.get returns the sub's docs (brief/roadmap/tasks).
 *   2. clawhq.tasks.toggle with subprojectSlug toggles the sub's TASKS.md
 *      (project-level TASKS.md is left untouched).
 *   3. plugin.clawhq.task.toggled carries subprojectSlug correctly.
 *   4. Invalid subSlug -> NOT_FOUND.
 *   5. Cleanup: rm -rf the disposable project.
 */
import { WebSocket } from "ws";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const WORKSPACE = process.env.CLAWHQ_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");
const PROJECT_SLUG = "clawhq-smoke-test";
const SUB_SLUG = "sub-alpha";
const PROJECT_DIR = path.join(WORKSPACE, "projects", PROJECT_SLUG);
const SUB_DIR = path.join(PROJECT_DIR, "subprojects", SUB_SLUG);

const PROJECT_BRIEF = `# Smoke Project

Test fixture for phaseC2 smoke. Status: active.
`;

const PROJECT_TASKS = `# Project Tasks

- [ ] project-task-one
- [ ] project-task-two
`;

const SUB_BRIEF = `---
name: Sub Alpha
status: active
blurb: A disposable subproject.
---

# Sub Alpha

Body content for the subproject.
`;

const SUB_ROADMAP = `# Sub Alpha — Roadmap

Phase A: scaffold
Phase B: ship
`;

const SUB_TASKS = `# Sub Alpha — Tasks

## Claude
- [ ] sub-task-one
- [ ] sub-task-two
- [x] sub-task-three
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

async function setup() {
  await fs.mkdir(SUB_DIR, { recursive: true });
  await fs.writeFile(path.join(PROJECT_DIR, "BRIEF.md"), PROJECT_BRIEF, "utf8");
  await fs.writeFile(path.join(PROJECT_DIR, "TASKS.md"), PROJECT_TASKS, "utf8");
  await fs.writeFile(path.join(SUB_DIR, "BRIEF.md"), SUB_BRIEF, "utf8");
  await fs.writeFile(path.join(SUB_DIR, "ROADMAP.md"), SUB_ROADMAP, "utf8");
  await fs.writeFile(path.join(SUB_DIR, "TASKS.md"), SUB_TASKS, "utf8");
}

async function teardown() {
  await fs.rm(PROJECT_DIR, { recursive: true, force: true });
}

async function main() {
  await setup();

  const A = openClient("A");
  const B = openClient("B");
  await Promise.all([A.ready, B.ready]);

  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // === clawhq.subprojects.get returns docs ===
  const subGet = await A.call("clawhq.subprojects.get", {
    projectSlug: PROJECT_SLUG,
    subSlug: SUB_SLUG,
  });
  log("A", `subprojects.get name="${subGet?.summary?.name}" status=${subGet?.summary?.status}`);
  if (subGet.summary?.parent !== PROJECT_SLUG) fail("sub.summary.parent mismatch");
  if (subGet.summary?.id !== SUB_SLUG) fail("sub.summary.id mismatch");
  if (subGet.summary?.name !== "Sub Alpha") fail(`sub.summary.name = ${subGet.summary?.name}`);
  if (subGet.summary?.status !== "active") fail(`sub.summary.status = ${subGet.summary?.status}`);
  if (!subGet.docs?.brief.includes("Body content")) fail("sub brief missing");
  if (!subGet.docs?.roadmap.includes("Phase A: scaffold")) fail("sub roadmap missing");
  if (!subGet.docs?.tasks.includes("sub-task-one")) fail("sub tasks missing");

  // === Toggle index 1 of subproject TASKS.md → true ===
  const evt = expectEvent(B, "plugin.clawhq.task.toggled");
  const res = await A.call("clawhq.tasks.toggle", {
    projectSlug: PROJECT_SLUG,
    subprojectSlug: SUB_SLUG,
    lineIndex: 1,
    checked: true,
  });
  const broadcast = await evt;
  log("B", `← toggled sub=${broadcast?.subprojectSlug} ${broadcast?.checkedCount}/${broadcast?.totalCount}`);
  if (broadcast.subprojectSlug !== SUB_SLUG) fail(`broadcast subprojectSlug ${broadcast.subprojectSlug}`);
  if (broadcast.projectSlug !== PROJECT_SLUG) fail(`broadcast projectSlug ${broadcast.projectSlug}`);
  if (res.totalCount !== 3) fail(`response totalCount ${res.totalCount} (expected 3)`);
  if (res.checkedCount !== 2) fail(`response checkedCount ${res.checkedCount} (expected 2)`);

  // === Sub TASKS.md was rewritten; project TASKS.md was NOT ===
  const subTasksOnDisk = await fs.readFile(path.join(SUB_DIR, "TASKS.md"), "utf8");
  if (!subTasksOnDisk.includes("- [x] sub-task-two")) fail("sub-task-two not flipped to checked");
  const projTasksOnDisk = await fs.readFile(path.join(PROJECT_DIR, "TASKS.md"), "utf8");
  if (projTasksOnDisk !== PROJECT_TASKS) fail("project-level TASKS.md was modified during sub toggle");

  // === Invalid subSlug -> NOT_FOUND ===
  try {
    await A.call("clawhq.subprojects.get", { projectSlug: PROJECT_SLUG, subSlug: "does-not-exist" });
    fail("subprojects.get on missing sub should fail");
  } catch (e) {
    if (!String(e.message).includes("NOT_FOUND")) fail(`missing sub: ${e.message}`);
  }

  // === Path traversal attempt -> rejected by slug regex ===
  try {
    await A.call("clawhq.subprojects.get", { projectSlug: PROJECT_SLUG, subSlug: "../../etc" });
    fail("subprojects.get with traversal slug should fail");
  } catch (e) {
    if (!String(e.message).includes("NOT_FOUND")) fail(`traversal: ${e.message}`);
  }

  A.close();
  B.close();
  await teardown();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: subprojects.get + sub-scoped tasks.toggle broadcast verified\n`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[test] fatal:", err);
  try { await teardown(); } catch { /* noop */ }
  process.exit(2);
});
