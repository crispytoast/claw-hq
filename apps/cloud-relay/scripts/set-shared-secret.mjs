#!/usr/bin/env node
/**
 * Flip claw-hq auth to shared-secret mode + bcrypt the chosen passphrase.
 *
 * Usage:
 *   CLAW_HQ_SECRET='your passphrase' node apps/cloud-relay/scripts/set-shared-secret.mjs
 *   echo 'your passphrase' | node apps/cloud-relay/scripts/set-shared-secret.mjs
 *
 * After running, restart the relay so it re-reads config.json:
 *   systemctl --user restart claw-hq.service
 *
 * Rerun any time to rotate the passphrase.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import bcrypt from "bcryptjs";

const CONFIG_PATH = process.env.CLAW_HQ_CONFIG ?? resolve(homedir(), ".claw-hq", "config.json");
const MIN_LEN = 12;

async function readPassphrase() {
  if (typeof process.env.CLAW_HQ_SECRET === "string" && process.env.CLAW_HQ_SECRET.length > 0) {
    return process.env.CLAW_HQ_SECRET;
  }
  if (process.stdin.isTTY) {
    console.error("error: pass the passphrase via CLAW_HQ_SECRET env var or stdin pipe");
    console.error("       (TTY entry would leave the plaintext in your shell history)");
    process.exit(1);
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "");
}

const passphrase = await readPassphrase();
if (passphrase.length < MIN_LEN) {
  console.error(`error: passphrase must be at least ${MIN_LEN} characters (got ${passphrase.length})`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch (err) {
  console.error(`error: could not read ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

const prevMode = cfg.auth?.mode ?? "trusted-lan";
const hash = await bcrypt.hash(passphrase, 10);
cfg.auth = { mode: "shared-secret", sharedSecretHash: hash };
writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });

console.log(`OK — flipped auth.mode: ${prevMode} → shared-secret in ${CONFIG_PATH}`);
console.log("Next: systemctl --user restart claw-hq.service");
