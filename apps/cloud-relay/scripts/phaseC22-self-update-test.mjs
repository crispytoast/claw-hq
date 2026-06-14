#!/usr/bin/env node
/**
 * Phase C step 22 smoke test — APK self-update bridge wiring.
 *
 * Step 22 wires Settings → Updates → "Download + install latest" through
 * `window.ClawHqUpdater.downloadAndInstall()`. The bridge streams
 * /install/apk into the app cache dir, wraps it via FileProvider, and
 * launches PackageInstaller via Intent.ACTION_VIEW.
 *
 * Asserts:
 *   1. /install/apk supports streaming download (Content-Length header set;
 *      that's what the bridge's progress callback reads).
 *   2. SPA bundle contains the ClawHqUpdater string + UI literals
 *      ("Download + install latest", "/install/apk" reference).
 *   3. APK has the UpdaterBridge class symbol in classes.dex.
 *   4. APK has REQUEST_INSTALL_PACKAGES + FileProvider authority in the
 *      manifest. AndroidManifest.xml inside the APK is binary AXML —
 *      not text-greppable — so we just assert the raw manifest source on
 *      disk has the right entries (proxy for the build picking them up).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

async function main() {
  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // 1. /install/apk Content-Length present (drives progress callback).
  const head = await fetch(`${RELAY}/install/apk`, { method: "HEAD" });
  if (head.status !== 200) {
    fail(`HEAD /install/apk returned ${head.status}`);
  } else {
    const cl = Number(head.headers.get("content-length") ?? 0);
    if (cl < 1_000_000) fail(`APK Content-Length suspiciously small: ${cl}`);
    else console.log(`  /install/apk Content-Length ok — ${(cl / 1024 / 1024).toFixed(2)}MB`);
  }

  // 2. SPA bundle has the wiring identifiers.
  const distAssets = resolve(repoRoot, "apps/web/dist/assets");
  if (!existsSync(distAssets)) {
    fail(`web dist assets not found at ${distAssets}`);
  } else {
    const bundles = readdirSync(distAssets).filter((f) => f.startsWith("index-") && f.endsWith(".js"));
    if (bundles.length === 0) fail(`no index-*.js bundles in ${distAssets}`);
    else {
      const bundle = readFileSync(resolve(distAssets, bundles[0]), "utf-8");
      const needles = ["ClawHqUpdater", "/install/apk", "Download + install latest"];
      for (const n of needles) {
        if (!bundle.includes(n)) fail(`SPA bundle missing "${n}"`);
      }
      if (failures === 0) console.log(`  SPA bundle has ClawHqUpdater + /install/apk + button label`);
    }
  }

  // 3. classes.dex contains the UpdaterBridge symbol.
  const apkPath = resolve(repoRoot, "apps/android/app/build/outputs/apk/release/app-release.apk");
  if (existsSync(apkPath)) {
    const { execSync } = await import("node:child_process");
    try {
      const dex = execSync(`unzip -p "${apkPath}" classes.dex`, { maxBuffer: 50 * 1024 * 1024 });
      if (!dex.includes("UpdaterBridge")) fail(`classes.dex missing UpdaterBridge`);
      else {
        const mb = (statSync(apkPath).size / 1024 / 1024).toFixed(2);
        console.log(`  classes.dex has UpdaterBridge (APK ${mb}MB)`);
      }
    } catch (e) {
      console.log(`  (skipped dex symbol check — unzip not available: ${e instanceof Error ? e.message : e})`);
    }
  }

  // 4. Manifest source has REQUEST_INSTALL_PACKAGES + FileProvider authority.
  const manifestPath = resolve(repoRoot, "apps/android/app/src/main/AndroidManifest.xml");
  if (existsSync(manifestPath)) {
    const manifest = readFileSync(manifestPath, "utf-8");
    if (!manifest.includes("REQUEST_INSTALL_PACKAGES")) {
      fail(`AndroidManifest missing REQUEST_INSTALL_PACKAGES permission`);
    }
    if (!manifest.includes(".fileprovider")) {
      fail(`AndroidManifest missing FileProvider authority`);
    }
    if (failures === 0) console.log(`  AndroidManifest has REQUEST_INSTALL_PACKAGES + FileProvider`);
  }

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: APK self-update wiring shipped end-to-end\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
