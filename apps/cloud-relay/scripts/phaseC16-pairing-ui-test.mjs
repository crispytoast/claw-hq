#!/usr/bin/env node
/**
 * Phase C step 16 smoke test — pairing-token REST round-trip.
 *
 * Step 16's plugins-management-page idea was killed by recon: no plugins.*
 * RPCs exist on the wire (verified via /tmp/probe-plugins.mjs — all 11 probed
 * methods returned "unknown method"). Plugin management is openclaw-CLI-only;
 * the queue brief explicitly says "don't build a tunnel-agent shell-out without
 * checking with Frank — that's a security surface change."
 *
 * Picked Settings → Pairing UI (Phase B 4b honorable mention) instead. The
 * kebab menu's `alert()`-based paired-devices viewer is replaced with a
 * proper Settings tab that lists tokens, issues new ones, and revokes them.
 *
 * This smoke exercises the three pairing REST endpoints the new tab drives:
 *   POST /api/pairing/tokens (issue)
 *   GET /api/pairing/tokens (list)
 *   DELETE /api/pairing/tokens/:token (revoke)
 *
 * The cleanup step (delete) means we leave the relay's pairing-tokens DB in
 * the same state we found it.
 */

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";
const LABEL = `phaseC16-smoke-${Date.now()}`;

async function req(path, init = {}) {
  // Only set Content-Type when we're sending a body — Fastify rejects empty
  // bodies on requests that declare application/json.
  const headers = init.body
    ? { "Content-Type": "application/json", ...(init.headers ?? {}) }
    : { ...(init.headers ?? {}) };
  const res = await fetch(`${RELAY}${path}`, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* may be 204 */ }
  return { status: res.status, body };
}

async function main() {
  let failures = 0;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

  // 1. Issue a new pairing token. In trusted-lan mode the relay treats every
  //    request as the owner — no cookie required.
  const issue = await req("/api/pairing/tokens", {
    method: "POST",
    body: JSON.stringify({ label: LABEL }),
  });
  if (issue.status !== 200) {
    fail(`issue returned ${issue.status}: ${JSON.stringify(issue.body)}`);
    process.exit(1);
  }
  const issued = issue.body;
  if (!issued || typeof issued.pairingToken !== "string") {
    fail(`issue payload missing pairingToken: ${JSON.stringify(issued)}`);
    process.exit(1);
  }
  if (issued.label !== LABEL) {
    fail(`issue echoed wrong label: ${issued.label}`);
  }
  if (typeof issued.pairCommand !== "string" || !issued.pairCommand.includes(issued.pairingToken)) {
    fail(`pairCommand missing or doesn't carry the token`);
  }
  console.log(`  issue ok — token ${issued.pairingToken.slice(0, 8)}…`);

  // 2. List tokens; the freshly-issued one must be present.
  const list = await req("/api/pairing/tokens");
  if (list.status !== 200) {
    fail(`list returned ${list.status}`);
  }
  const tokens = list.body?.tokens;
  if (!Array.isArray(tokens)) {
    fail(`list payload missing tokens array: ${JSON.stringify(list.body)}`);
  } else {
    const found = tokens.find((t) => t.token === issued.pairingToken);
    if (!found) {
      fail(`issued token absent from list (${tokens.length} entries)`);
    } else if (found.label !== LABEL) {
      fail(`listed token has wrong label: ${found.label}`);
    } else {
      console.log(`  list ok — ${tokens.length} total tokens, includes our smoke token`);
    }
  }

  // 3. Revoke (cleanup).
  const revoke = await req(`/api/pairing/tokens/${encodeURIComponent(issued.pairingToken)}`, {
    method: "DELETE",
  });
  if (revoke.status !== 200) {
    fail(`revoke returned ${revoke.status}: ${JSON.stringify(revoke.body)}`);
  } else {
    console.log(`  revoke ok`);
  }

  // 4. List again — must NOT contain the revoked token.
  const list2 = await req("/api/pairing/tokens");
  const tokens2 = list2.body?.tokens;
  if (Array.isArray(tokens2) && tokens2.some((t) => t.token === issued.pairingToken)) {
    fail(`revoked token still present in list — cleanup failed`);
  }

  // 5. Revoking again must 404 — that's how the SPA knows the user wasn't fooled
  //    by stale state.
  const revoke2 = await req(`/api/pairing/tokens/${encodeURIComponent(issued.pairingToken)}`, {
    method: "DELETE",
  });
  if (revoke2.status !== 404) {
    fail(`second revoke should 404, got ${revoke2.status}`);
  }

  if (failures > 0) {
    console.error(`\n  ${failures} failure(s)\n`);
    process.exit(1);
  }
  console.log(`\n  Result: pairing-token REST round-trip ok (issue + list + revoke + 404-on-double-revoke)\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(2);
});
