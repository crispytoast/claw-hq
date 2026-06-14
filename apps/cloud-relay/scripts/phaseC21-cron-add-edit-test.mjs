#!/usr/bin/env node
/**
 * Phase C step 21 smoke test — cron.add / cron.update round-trip.
 *
 * Step 21 wires "+ New job" + per-row Edit on the CronPage. Both buttons drive
 * `cron.add({name, cron, session:"isolated", message, kind:"message", enabled})`
 * and `cron.update({id, name, cron, message, enabled})` per the doc + my
 * earlier wire probe. This smoke exercises the full lifecycle:
 *
 *   1. cron.add a disposable job
 *   2. cron.list finds it
 *   3. cron.update rewrites the message
 *   4. cron.list shows the new message
 *   5. cron.remove cleans it up
 *
 * Self-cleaning by name prefix so a partial failure doesn't pollute the
 * gateway's cron registry.
 */
import { WebSocket } from "ws";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const NAME_PREFIX = "phaseC21-smoke-";
const NAME = `${NAME_PREFIX}${Date.now().toString(36)}`;

let nextId = 1;
const reqId = () => `t-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;

function openClient() {
  const url = RELAY.replace(/^http/, "ws") + "/ws/client";
  const ws = new WebSocket(url);
  const pending = new Map();
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  ws.on("message", (raw) => {
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
    const frame = env.frame;
    if (frame.type === "event" && frame.event === "claw.session_ready") readyResolve();
    if (frame.type === "res") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      entry.resolve(frame);
    }
  });
  const call = async (method, params) => {
    const id = reqId();
    ws.send(JSON.stringify({
      kind: "frame", clientId: "self", direction: "client-to-agent",
      frame: { type: "req", id, method, params: params ?? {} },
    }));
    const frame = await new Promise((resolve) => { pending.set(id, { resolve }); }).then(({ resolve }) => resolve);
    // Above resolves with the frame directly.
    return frame;
  };
  return { ws, ready, call };
}

async function main() {
  const c = openClient();
  await c.ready;

  let failures = 0;
  let createdId = null;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // Wrap call to unwrap the frame correctly.
  const rawCall = (method, params) => new Promise((resolve) => {
    const id = reqId();
    c.ws.send(JSON.stringify({
      kind: "frame", clientId: "self", direction: "client-to-agent",
      frame: { type: "req", id, method, params: params ?? {} },
    }));
    // overload pending listener
    const handler = (raw) => {
      const env = JSON.parse(raw.toString());
      if (env.kind !== "frame" || env.direction !== "agent-to-client") return;
      const frame = env.frame;
      if (frame.type !== "res" || frame.id !== id) return;
      c.ws.off("message", handler);
      resolve(frame);
    };
    c.ws.on("message", handler);
  });

  try {
    // 1. add
    const addRes = await rawCall("cron.add", {
      name: NAME,
      cron: "0 7 * * *",
      session: "isolated",
      message: "phaseC21 initial message",
      kind: "message",
      enabled: true,
    });
    if (!addRes.ok) {
      fail(`cron.add failed: ${addRes.error?.code} ${addRes.error?.message}`);
      return;
    }
    createdId = addRes.payload?.id;
    if (!createdId) {
      fail(`cron.add response missing id: ${JSON.stringify(addRes.payload).slice(0, 200)}`);
      return;
    }
    console.log(`  cron.add ok — id=${createdId.slice(0, 8)}…`);

    // 2. list — find by name
    const listRes = await rawCall("cron.list", { limit: 200 });
    if (!listRes.ok) {
      fail(`cron.list failed: ${listRes.error?.code}`);
    } else {
      const jobs = listRes.payload?.jobs ?? [];
      const found = jobs.find((j) => j.id === createdId);
      if (!found) fail(`cron.list missing job ${createdId}`);
      else console.log(`  cron.list found job (${jobs.length} total)`);
    }

    // 3. update message — validator wants {jobId, patch:{...}}
    const updRes = await rawCall("cron.update", {
      jobId: createdId,
      patch: { message: "phaseC21 updated message" },
    });
    if (!updRes.ok) {
      fail(`cron.update failed: ${updRes.error?.code} ${updRes.error?.message}`);
    } else {
      console.log(`  cron.update ok`);
    }

    // 4. list again — assert the new message landed
    const list2 = await rawCall("cron.list", { limit: 200 });
    if (list2.ok) {
      const job = (list2.payload?.jobs ?? []).find((j) => j.id === createdId);
      const msg = job?.message ?? job?.payload?.message;
      if (!msg) fail(`updated job missing message field`);
      else if (msg !== "phaseC21 updated message") {
        fail(`updated message mismatch: ${msg}`);
      } else {
        console.log(`  cron.list reflects updated message`);
      }
    }
  } finally {
    // 5. cleanup
    if (createdId) {
      const rm = await rawCall("cron.remove", { id: createdId });
      if (!rm.ok) console.warn(`  cleanup remove failed: ${rm.error?.message}`);
      else console.log(`  cron.remove ok (cleanup)`);
    }
    // Sweep any leftover smoke jobs from prior runs.
    const sweep = await rawCall("cron.list", { limit: 200 });
    if (sweep.ok) {
      for (const j of sweep.payload?.jobs ?? []) {
        if (j.name?.startsWith(NAME_PREFIX) && j.id && j.id !== createdId) {
          await rawCall("cron.remove", { id: j.id });
          console.log(`  swept stale ${j.id.slice(0, 8)}…`);
        }
      }
    }
    c.ws.close();
  }

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: cron.add + cron.update round-trip ok\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
