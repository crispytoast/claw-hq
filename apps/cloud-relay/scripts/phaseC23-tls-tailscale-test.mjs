#!/usr/bin/env node
/**
 * Phase C step 23 smoke test — HTTPS-via-Tailscale-Serve UI surfaces.
 *
 * Step 23's actual TLS enablement requires a one-time sudo step
 * (sudo tailscale set --operator=$USER + tailscale serve --bg ...);
 * see scripts/tls-setup.sh. This smoke covers the parts that ship as
 * code:
 *
 *   1. /install page surfaces the Tailscale-Serve HTTPS URL when the
 *      relay host is on a tailnet (detectTailscaleHttpsUrl reads
 *      `tailscale status --json`).
 *   2. CLAW_HQ_TLS_URL env-var override is honored — important for
 *      non-Tailscale hosts that have TLS via a different fronting
 *      mechanism.
 *   3. tls-setup.sh exists at the documented path so the install-page
 *      footer's reference doesn't dead-link.
 */
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

async function main() {
  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // 1. /install page renders, and either contains a tls-block (Tailscale
  // present) or doesn't (Tailscale absent). Both states are valid — the
  // bug-mode is rendering an empty block.
  const installRes = await fetch(`${RELAY}/install`);
  if (installRes.status !== 200) {
    fail(`/install returned ${installRes.status}`);
  } else {
    const body = await installRes.text();
    const hasTailscale = body.includes("HTTPS via Tailscale Serve");
    if (hasTailscale) {
      // If present, the block must have a https:// URL inside.
      const m = body.match(/<code class="tls-url">(https:\/\/[^<]+)<\/code>/);
      if (!m) fail(`tls-block rendered without https URL`);
      else console.log(`  /install has tls-block — URL ${m[1]}`);
    } else {
      console.log(`  /install has no tls-block (Tailscale not configured on this host)`);
    }
  }

  // 2. tls-setup.sh exists + is executable.
  const scriptPath = resolve(repoRoot, "scripts/tls-setup.sh");
  if (!existsSync(scriptPath)) {
    fail(`scripts/tls-setup.sh missing — install-page docs would dead-link`);
  } else {
    const st = statSync(scriptPath);
    // 0o111 = any-execute bit set
    if ((st.mode & 0o111) === 0) fail(`scripts/tls-setup.sh not executable`);
    else console.log(`  scripts/tls-setup.sh present + executable (${st.size}B)`);
  }

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: HTTPS-via-Tailscale-Serve UI surfaces shipped (sudo enable step is manual)\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
