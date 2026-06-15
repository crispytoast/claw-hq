#!/usr/bin/env node
/**
 * Smoke test for the OHQ-migration Day 1 auth flip.
 *
 * Covers the helper script (set-shared-secret.mjs) without touching
 * ~/.claw-hq/config.json. Verifies:
 *   1. env-var path writes a valid shared-secret config
 *   2. stdin-pipe path writes a valid shared-secret config
 *   3. bcrypt round-trip — right passphrase verifies, wrong fails
 *   4. too-short passphrase exits non-zero, config unchanged
 *   5. existing fields (port, host, publicUrl, dataDir) survive the flip
 *
 * Does NOT restart the live relay. Does NOT touch the real config file.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import bcrypt from "bcryptjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(HERE, "set-shared-secret.mjs");

const BASE_CONFIG = {
  port: 9999,
  host: "127.0.0.1",
  publicUrl: "http://localhost:9999",
  run: { relay: true, tunnel: true },
  auth: { mode: "trusted-lan" },
  tunnel: { relayUrl: "in-process", openclawConfigPath: "/tmp/fake-openclaw.json" },
  dataDir: "/tmp/fake-claw-hq-data",
  webDistPath: "/tmp/fake-web-dist",
};

const tmp = mkdtempSync(resolve(tmpdir(), "phaseM1-"));
const cfgPath = resolve(tmp, "config.json");

function writeBase() {
  writeFileSync(cfgPath, JSON.stringify(BASE_CONFIG, null, 2));
}

function runHelper({ env = {}, input = undefined }) {
  return spawnSync(process.execPath, [HELPER], {
    env: { ...process.env, CLAW_HQ_CONFIG: cfgPath, ...env },
    input,
    encoding: "utf-8",
  });
}

function readCfg() {
  return JSON.parse(readFileSync(cfgPath, "utf-8"));
}

const failures = [];
function assert(cond, label) {
  if (cond) { console.log(`  ok   ${label}`); }
  else      { console.error(`  FAIL ${label}`); failures.push(label); }
}

try {
  // -------- case 1: env-var path
  writeBase();
  const pass1 = "correct-horse-battery-staple-12";
  const r1 = runHelper({ env: { CLAW_HQ_SECRET: pass1 } });
  assert(r1.status === 0, "env-var helper exits 0");
  const cfg1 = readCfg();
  assert(cfg1.auth.mode === "shared-secret", "env-var: auth.mode flipped to shared-secret");
  assert(typeof cfg1.auth.sharedSecretHash === "string" && cfg1.auth.sharedSecretHash.length > 0, "env-var: sharedSecretHash present");
  assert(await bcrypt.compare(pass1, cfg1.auth.sharedSecretHash), "env-var: right passphrase verifies");
  assert(!(await bcrypt.compare("wrong-passphrase-1234", cfg1.auth.sharedSecretHash)), "env-var: wrong passphrase rejected");
  assert(cfg1.port === 9999 && cfg1.host === "127.0.0.1", "env-var: existing port/host preserved");
  assert(cfg1.publicUrl === "http://localhost:9999", "env-var: publicUrl preserved");
  assert(cfg1.dataDir === "/tmp/fake-claw-hq-data", "env-var: dataDir preserved");
  assert(cfg1.tunnel?.openclawConfigPath === "/tmp/fake-openclaw.json", "env-var: tunnel block preserved");

  // -------- case 2: stdin-pipe path
  writeBase();
  const pass2 = "another-strong-secret-9876";
  const r2 = runHelper({ input: pass2 + "\n" });
  assert(r2.status === 0, "stdin helper exits 0");
  const cfg2 = readCfg();
  assert(cfg2.auth.mode === "shared-secret", "stdin: auth.mode flipped");
  assert(await bcrypt.compare(pass2, cfg2.auth.sharedSecretHash), "stdin: right passphrase verifies");

  // -------- case 3: too short
  writeBase();
  const r3 = runHelper({ env: { CLAW_HQ_SECRET: "short" } });
  assert(r3.status !== 0, "too-short helper exits non-zero");
  const cfg3 = readCfg();
  assert(cfg3.auth.mode === "trusted-lan", "too-short: config unchanged");

  // -------- case 4: re-flip (rotation) — should re-bcrypt cleanly
  writeBase();
  runHelper({ env: { CLAW_HQ_SECRET: "first-passphrase-aaaa" } });
  const first = readCfg().auth.sharedSecretHash;
  runHelper({ env: { CLAW_HQ_SECRET: "second-passphrase-bbbb" } });
  const second = readCfg().auth.sharedSecretHash;
  assert(first !== second, "rotation: hash changes between runs");
  assert(await bcrypt.compare("second-passphrase-bbbb", second), "rotation: latest passphrase verifies");
  assert(!(await bcrypt.compare("first-passphrase-aaaa", second)), "rotation: old passphrase no longer verifies");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log("\nphaseM1 auth flip: all checks passed");
