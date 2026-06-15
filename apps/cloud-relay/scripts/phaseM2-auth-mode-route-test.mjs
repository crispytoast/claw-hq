#!/usr/bin/env node
/**
 * OHQ-migration Day 1 smoke test #2 — in-UI auth mode flip via /api/auth/mode.
 *
 * Boots Fastify in-process with auth routes registered against a temp config
 * + temp DB so we don't touch ~/.claw-hq. Verifies the full hot-flip flow:
 *
 *   1. GET /api/auth/mode reports trusted-lan + no passphrase initially.
 *   2. POST /api/auth/mode flips to shared-secret (anyone-on-LAN allowed
 *      while in trusted-lan, since resolveOwner returns the synthetic owner).
 *   3. Post-flip, /api/auth/me now 401s with mode:"shared-secret" in the body.
 *   4. POST /api/auth/login with the chosen passphrase sets a cookie + 200s.
 *   5. The cookie carries an authed session into /api/auth/me.
 *   6. Wrong passphrase → 401.
 *   7. Post-flip, POST /api/auth/mode now REQUIRES the cookie (no cookie → 401).
 *   8. With cookie, rotation works: new passphrase verifies, old one rejected.
 *   9. Short passphrase → 400 + config unchanged.
 *  10. Trusted-lan path for /api/auth/login returns 400 (login not applicable).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_MOD = resolve(HERE, "../src/auth.ts");
const CONFIG_MOD = resolve(HERE, "../src/config.ts");
const DB_MOD = resolve(HERE, "../src/db.ts");

const tmp = mkdtempSync(resolve(tmpdir(), "phaseM2-"));
const cfgPath = resolve(tmp, "config.json");
const dataDir = resolve(tmp, "data");

writeFileSync(cfgPath, JSON.stringify({
  port: 9999,
  host: "127.0.0.1",
  publicUrl: "http://localhost:9999",
  run: { relay: true, tunnel: true },
  auth: { mode: "trusted-lan" },
  tunnel: { relayUrl: "in-process", openclawConfigPath: "/tmp/fake-openclaw.json" },
  dataDir,
  webDistPath: "/tmp/fake-web",
}, null, 2));

const driver = `
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { resolveConfig, readConfig } from ${JSON.stringify(CONFIG_MOD)};
import { openDb } from ${JSON.stringify(DB_MOD)};
import { registerAuthRoutes } from ${JSON.stringify(AUTH_MOD)};
import { readFileSync } from "node:fs";

(async () => {
  const config = resolveConfig(readConfig());
  const db = openDb(config.dbPath);
  const f = Fastify();
  await f.register(fastifyCookie);
  await registerAuthRoutes(f, { db, config });
  await f.ready();

  const out = {};
  const hit = async (method, url, opts = {}) => {
    const r = await f.inject({ method, url, ...opts });
    return { status: r.statusCode, headers: r.headers, body: r.payload };
  };

  out.modeBefore = await hit("GET", "/api/auth/mode");
  out.meBeforeFlip = await hit("GET", "/api/auth/me");
  out.loginInTrustedLan = await hit("POST", "/api/auth/login", {
    headers: { "content-type": "application/json" },
    payload: { password: "irrelevant" },
  });

  out.flip = await hit("POST", "/api/auth/mode", {
    headers: { "content-type": "application/json" },
    payload: { passphrase: "correct-horse-battery-stapler" },
  });
  out.modeAfter = await hit("GET", "/api/auth/mode");
  out.meAfterFlip = await hit("GET", "/api/auth/me");

  out.loginWrong = await hit("POST", "/api/auth/login", {
    headers: { "content-type": "application/json" },
    payload: { password: "wrong-passphrase-xxxx" },
  });
  out.loginRight = await hit("POST", "/api/auth/login", {
    headers: { "content-type": "application/json" },
    payload: { password: "correct-horse-battery-stapler" },
  });

  // Extract chq_session cookie from set-cookie header.
  const cookieHeader = out.loginRight.headers["set-cookie"];
  let cookie = "";
  if (typeof cookieHeader === "string") {
    cookie = cookieHeader.split(";")[0];
  } else if (Array.isArray(cookieHeader)) {
    cookie = cookieHeader[0].split(";")[0];
  }
  out.cookieExtracted = cookie.startsWith("chq_session=");

  out.meWithCookie = await hit("GET", "/api/auth/me", { headers: { cookie } });

  out.modeWithoutCookie = await hit("POST", "/api/auth/mode", {
    headers: { "content-type": "application/json" },
    payload: { passphrase: "second-passphrase-mnop" },
  });
  out.rotateWithCookie = await hit("POST", "/api/auth/mode", {
    headers: { "content-type": "application/json", cookie },
    payload: { passphrase: "second-passphrase-mnop" },
  });

  out.loginOldFails = await hit("POST", "/api/auth/login", {
    headers: { "content-type": "application/json" },
    payload: { password: "correct-horse-battery-stapler" },
  });
  out.loginNewWorks = await hit("POST", "/api/auth/login", {
    headers: { "content-type": "application/json" },
    payload: { password: "second-passphrase-mnop" },
  });

  out.shortRejected = await hit("POST", "/api/auth/mode", {
    headers: { "content-type": "application/json", cookie },
    payload: { passphrase: "too-short" },
  });
  out.modeStillSharedSecret = await hit("GET", "/api/auth/mode");
  out.configOnDisk = JSON.parse(readFileSync(${JSON.stringify(cfgPath)}, "utf-8"));

  await f.close();
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(2); });
`;

const env = {
  ...process.env,
  CLAW_HQ_CONFIG: cfgPath,
  CLAW_HQ_DATA_DIR: dataDir,
  CLAW_HQ_LOG_LEVEL: "warn",
};

const run = spawnSync("npx", ["-y", "tsx", "--eval", driver], {
  cwd: resolve(HERE, ".."),
  env,
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (run.status !== 0) {
  console.error("driver failed:");
  console.error(run.stderr || run.stdout);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(2);
}

let res;
try { res = JSON.parse(run.stdout); }
catch { console.error("driver stdout not JSON:"); console.error(run.stdout); process.exit(2); }

const failures = [];
const assert = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}`); failures.push(label); }
};

assert(res.modeBefore.status === 200, "GET /api/auth/mode → 200 in trusted-lan");
assert(JSON.parse(res.modeBefore.body).mode === "trusted-lan", "mode reports trusted-lan");
assert(JSON.parse(res.modeBefore.body).hasPassphrase === false, "hasPassphrase=false initially");

assert(res.meBeforeFlip.status === 200, "GET /api/auth/me → 200 in trusted-lan (synthetic owner)");
assert(res.loginInTrustedLan.status === 400, "POST /api/auth/login in trusted-lan → 400");

assert(res.flip.status === 200, "POST /api/auth/mode (trusted-lan) → 200 (anyone allowed)");
assert(JSON.parse(res.flip.body).mode === "shared-secret", "flip response carries new mode");

assert(res.modeAfter.status === 200, "GET /api/auth/mode after flip → 200");
assert(JSON.parse(res.modeAfter.body).mode === "shared-secret", "mode now shared-secret");
assert(JSON.parse(res.modeAfter.body).hasPassphrase === true, "hasPassphrase=true after flip");

assert(res.meAfterFlip.status === 401, "GET /api/auth/me after flip (no cookie) → 401");
assert(JSON.parse(res.meAfterFlip.body).mode === "shared-secret", "401 body carries mode so SPA can render right form");

assert(res.loginWrong.status === 401, "wrong passphrase → 401");
assert(res.loginRight.status === 200, "right passphrase → 200");
assert(res.cookieExtracted, "right passphrase set chq_session cookie");
assert(res.meWithCookie.status === 200, "/api/auth/me with cookie → 200");

assert(res.modeWithoutCookie.status === 401, "POST /api/auth/mode without cookie post-flip → 401");
assert(res.rotateWithCookie.status === 200, "POST /api/auth/mode with cookie → 200 (rotation)");

assert(res.loginOldFails.status === 401, "old passphrase rejected after rotation");
assert(res.loginNewWorks.status === 200, "new passphrase works after rotation");

assert(res.shortRejected.status === 400, "short passphrase → 400");
assert(JSON.parse(res.modeStillSharedSecret.body).mode === "shared-secret", "short-passphrase attempt did not corrupt mode");
assert(res.configOnDisk.auth.mode === "shared-secret", "config.json on disk reflects shared-secret");
assert(typeof res.configOnDisk.auth.sharedSecretHash === "string" && res.configOnDisk.auth.sharedSecretHash.length > 0, "config.json carries a hash");

rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log("\nphaseM2 in-UI auth mode flip: all checks passed");
