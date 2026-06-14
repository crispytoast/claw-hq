#!/usr/bin/env node
/**
 * Phase C step 11 smoke test — clawhq.subprojects.list returns a flat array
 * across every project.
 *
 *   1. Set up two disposable projects with subprojects each.
 *   2. Call clawhq.subprojects.list and confirm both parents' subs appear
 *      with parent + id + status + progress.
 *   3. Subs are sorted by lastUpdatedMs desc.
 *   4. Cleanup.
 */
import { WebSocket } from "ws";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const WORKSPACE = process.env.CLAWHQ_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");

const PROJECT_A = "clawhq-smoke-list-a";
const PROJECT_B = "clawhq-smoke-list-b";
const dirs = [
  path.join(WORKSPACE, "projects", PROJECT_A, "subprojects", "alpha"),
  path.join(WORKSPACE, "projects", PROJECT_A, "subprojects", "beta"),
  path.join(WORKSPACE, "projects", PROJECT_B, "subprojects", "gamma"),
];

const BRIEF = (name, status) =>
  `---\nname: ${name}\nstatus: ${status}\nblurb: ${name} blurb\n---\n# ${name}\n`;

async function setup() {
  for (const d of dirs) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(dirs[0], "BRIEF.md"), BRIEF("Alpha", "active"));
  await fs.writeFile(path.join(dirs[0], "TASKS.md"), "- [x] one\n- [ ] two\n"); // 50%
  await fs.writeFile(path.join(dirs[1], "BRIEF.md"), BRIEF("Beta", "done"));
  await fs.writeFile(path.join(dirs[2], "BRIEF.md"), BRIEF("Gamma", "back-burner"));
}

async function teardown() {
  for (const slug of [PROJECT_A, PROJECT_B]) {
    await fs.rm(path.join(WORKSPACE, "projects", slug), { recursive: true, force: true });
  }
}

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

async function main() {
  await setup();
  const c = openClient();
  await c.ready;

  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  const res = await c.call("clawhq.subprojects.list", {});
  const subs = res.subprojects;
  if (!Array.isArray(subs)) fail("response.subprojects not an array");

  const byKey = new Map(subs.map((s) => [`${s.parent}/${s.id}`, s]));
  const wantedKeys = [`${PROJECT_A}/alpha`, `${PROJECT_A}/beta`, `${PROJECT_B}/gamma`];
  for (const k of wantedKeys) {
    if (!byKey.has(k)) fail(`missing ${k}`);
  }

  const alpha = byKey.get(`${PROJECT_A}/alpha`);
  if (alpha?.status !== "active") fail(`alpha status ${alpha?.status}`);
  if (alpha?.progress !== 50) fail(`alpha progress ${alpha?.progress}`);
  if (alpha?.parent !== PROJECT_A) fail(`alpha parent ${alpha?.parent}`);

  const beta = byKey.get(`${PROJECT_A}/beta`);
  if (beta?.status !== "done") fail(`beta status ${beta?.status}`);

  const gamma = byKey.get(`${PROJECT_B}/gamma`);
  if (gamma?.status !== "back-burner") fail(`gamma status ${gamma?.status}`);

  // Sorted by lastUpdatedMs desc.
  const ours = subs.filter((s) => wantedKeys.includes(`${s.parent}/${s.id}`));
  for (let i = 1; i < ours.length; i++) {
    if (ours[i - 1].lastUpdatedMs < ours[i].lastUpdatedMs) {
      fail(`not sorted desc at idx ${i}`);
      break;
    }
  }

  c.ws.close();
  await teardown();

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: subprojects.list returned ${subs.length} entries across ${new Set(subs.map(s => s.parent)).size} project(s)\n`);
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[test] fatal:", err);
  try { await teardown(); } catch { /* noop */ }
  process.exit(2);
});
