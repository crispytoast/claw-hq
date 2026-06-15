#!/usr/bin/env node
/**
 * Phase C step 36 smoke test — main-session systemEvent cron jobs.
 *
 * Step 21 wired isolated-session "message" jobs via the flat shape but left
 * main-session systemEvent jobs CLI-only. Step 36 plumbs them through the
 * CronPage using the structured schema:
 *
 *   {name, schedule:{kind:"cron",expr}, sessionTarget:"main",
 *    wakeMode:"next-heartbeat", payload:{kind:"systemEvent",text}}
 *
 * Probe (in this script) confirmed:
 *   - structured shape → works for main systemEvent
 *   - flat shape with {kind:"systemEvent"} → rejected with
 *     "main cron jobs require payload.kind=\"systemEvent\""
 *
 * This smoke locks the working contract end-to-end:
 *   1. cron.add (structured) — main systemEvent
 *   2. cron.list (enabled:"all") finds it with payload.kind="systemEvent"
 *   3. cron.update — text patch via {payload:{kind:"systemEvent",text}}
 *   4. cron.list shows the new text
 *   5. cron.remove cleans it up
 *
 * Self-cleans on exit via NAME_PREFIX sweep.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const NAME_PREFIX = "phaseC36-smoke-";

let nextId = 1;
const reqId = () => `t-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function openClient() {
  const url = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(url);
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  ws.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
    if (env.frame.type === "event" && env.frame.event === "claw.session_ready") readyResolve();
  });
  const call = (method, params) => new Promise((resolve) => {
    const id = reqId();
    ws.send(JSON.stringify({
      kind: "frame", clientId: "self", direction: "client-to-agent",
      frame: { type: "req", id, method, params: params ?? {} },
    }));
    const handler = (raw) => {
      const env = JSON.parse(raw.toString());
      if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
      if (env.frame.type !== "res" || env.frame.id !== id) return;
      ws.off("message", handler);
      resolve(env.frame);
    };
    ws.on("message", handler);
  });
  return { ws, ready, call };
}

async function main() {
  const c = openClient();
  await c.ready;

  let failures = 0;
  let createdId = null;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };
  const NAME = `${NAME_PREFIX}${Date.now().toString(36)}`;

  try {
    // 1. add — main systemEvent via structured schema, disabled so it doesn't fire
    const addRes = await c.call("cron.add", {
      name: NAME,
      enabled: false,
      schedule: { kind: "cron", expr: "0 4 * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "phaseC36 initial event" },
    });
    if (!addRes.ok) {
      fail(`cron.add (structured systemEvent) failed: ${addRes.error?.code} ${addRes.error?.message}`);
      return;
    }
    createdId = addRes.payload?.id;
    if (!createdId) {
      fail(`cron.add response missing id`);
      return;
    }
    console.log(`  cron.add structured ok — id=${createdId.slice(0, 8)}…`);

    // 2. list — find by name, verify payload.kind
    const listRes = await c.call("cron.list", { limit: 200, enabled: "all", includeDisabled: true });
    if (!listRes.ok) {
      fail(`cron.list failed: ${listRes.error?.code}`);
    } else {
      const job = (listRes.payload?.jobs ?? []).find((j) => j.id === createdId);
      if (!job) fail(`cron.list missing created systemEvent job ${createdId}`);
      else if (job.payload?.kind !== "systemEvent") {
        fail(`expected payload.kind=systemEvent, got ${job.payload?.kind} (raw: ${JSON.stringify(job).slice(0, 200)})`);
      } else if ((job.sessionTarget ?? job.session) !== "main") {
        fail(`expected sessionTarget=main, got ${job.sessionTarget ?? job.session}`);
      } else {
        console.log(`  cron.list returns systemEvent + main`);
      }
    }

    // 3. update — patch the event text via structured payload patch
    const updRes = await c.call("cron.update", {
      jobId: createdId,
      patch: {
        payload: { kind: "systemEvent", text: "phaseC36 updated event" },
      },
    });
    if (!updRes.ok) {
      fail(`cron.update systemEvent text failed: ${updRes.error?.code} ${updRes.error?.message}`);
    } else {
      console.log(`  cron.update payload patch ok`);
    }

    // 4. list again — assert the new text landed
    const list2 = await c.call("cron.list", { limit: 200, enabled: "all", includeDisabled: true });
    if (list2.ok) {
      const job = (list2.payload?.jobs ?? []).find((j) => j.id === createdId);
      const text = job?.payload?.text;
      if (text !== "phaseC36 updated event") {
        fail(`updated systemEvent text mismatch: ${text}`);
      } else {
        console.log(`  cron.list reflects updated systemEvent text`);
      }
    }

    // 5. flat-shape negative — confirm OpenClaw still rejects the legacy flat
    // form for systemEvent so the page knows to use structured.
    const flatRes = await c.call("cron.add", {
      name: `${NAME}-flat`,
      cron: "0 4 * * *",
      session: "main",
      message: "should be rejected",
      kind: "systemEvent",
      enabled: false,
    });
    if (flatRes.ok) {
      fail(`flat systemEvent unexpectedly accepted — page can switch to flat`);
      if (flatRes.payload?.id) await c.call("cron.remove", { id: flatRes.payload.id });
    } else {
      console.log(`  flat systemEvent rejected as expected`);
    }
  } finally {
    // cleanup
    if (createdId) {
      const rm = await c.call("cron.remove", { id: createdId });
      if (!rm.ok) console.warn(`  cleanup remove failed: ${rm.error?.message}`);
    }
    const sweep = await c.call("cron.list", { limit: 200, enabled: "all", includeDisabled: true });
    if (sweep.ok) {
      for (const j of sweep.payload?.jobs ?? []) {
        if (typeof j.name === "string" && j.name.startsWith(NAME_PREFIX)) {
          await c.call("cron.remove", { id: j.id });
          console.log(`  swept stale ${j.id?.slice(0, 8)}…`);
        }
      }
    }
    c.ws.close();
  }

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: main-session systemEvent add/list/update/remove cycle ok\n`);
  process.exit(0);
}

main().catch((err) => { console.error("[test] fatal:", err); process.exit(2); });
