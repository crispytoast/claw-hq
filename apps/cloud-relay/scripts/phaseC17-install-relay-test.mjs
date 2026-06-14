#!/usr/bin/env node
/**
 * Phase C step 17 smoke test — /install relay routes + push fanout config.
 *
 * Step 17 ships APK 0.4.3 (versionCode 4) + wires the standing /install route
 * so Frank can sideload from any browser on the Tailnet.
 *
 * Asserts:
 *   1. GET /install returns the HTML install page (with a download CTA).
 *   2. GET /install/apk returns the APK as application/vnd.android.package-archive
 *      with Content-Length matching disk.
 *   3. GET /api/push/__diag returns total registered devices ≥ 0 (proves the
 *      FCM fanout target table is reachable; doesn't require Frank's phone
 *      to be currently online).
 *
 * Does NOT call /api/push/send-test in this smoke — that would re-fire a push
 * to Frank every run. End-to-end push verification is done manually in the
 * commit message.
 */
import { statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";

async function main() {
  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // 1. /install HTML page.
  const installRes = await fetch(`${RELAY}/install`);
  if (installRes.status !== 200) {
    fail(`/install returned ${installRes.status}`);
  } else {
    const ct = installRes.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) {
      fail(`/install content-type not html: ${ct}`);
    }
    const body = await installRes.text();
    if (!body.includes("/install/apk")) {
      fail(`/install HTML missing /install/apk link`);
    } else {
      console.log(`  /install ok — landing page renders, links to APK`);
    }
  }

  // 2. /install/apk binary.
  const apkRes = await fetch(`${RELAY}/install/apk`);
  if (apkRes.status !== 200) {
    fail(`/install/apk returned ${apkRes.status}`);
  } else {
    const ct = apkRes.headers.get("content-type") ?? "";
    if (!ct.includes("vnd.android.package-archive")) {
      fail(`/install/apk content-type not APK: ${ct}`);
    }
    const cl = Number(apkRes.headers.get("content-length") ?? 0);
    if (cl < 1_000_000) {
      fail(`/install/apk content-length suspiciously small: ${cl}`);
    }
    // Cross-check with the source APK on disk. Skip if running against a remote
    // relay where we can't read the file directly.
    const here = fileURLToPath(import.meta.url);
    const repoRoot = resolve(here, "..", "..", "..", "..");
    const expected = resolve(repoRoot, "apps/android/app/build/outputs/apk/release/app-release.apk");
    if (existsSync(expected)) {
      const diskSize = statSync(expected).size;
      if (diskSize !== cl) {
        fail(`/install/apk size (${cl}) != disk APK (${diskSize})`);
      } else {
        console.log(`  /install/apk ok — ${(cl / 1024 / 1024).toFixed(1)}MB, matches disk`);
      }
    } else {
      console.log(`  /install/apk ok — ${(cl / 1024 / 1024).toFixed(1)}MB (no on-disk cross-check)`);
    }
  }

  // 3. Push diag — fanout target table reachable.
  const diagRes = await fetch(`${RELAY}/api/push/__diag`);
  if (diagRes.status !== 200) {
    fail(`/api/push/__diag returned ${diagRes.status}`);
  } else {
    const body = await diagRes.json();
    if (typeof body?.totalDevices !== "number") {
      fail(`/api/push/__diag missing totalDevices: ${JSON.stringify(body)}`);
    } else {
      console.log(`  /api/push/__diag ok — ${body.totalDevices} device(s) registered for push`);
    }
  }

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: /install routes serve APK + push fanout target reachable\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
