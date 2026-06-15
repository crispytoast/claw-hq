#!/usr/bin/env node
/**
 * Phase C step 37 smoke — re-attachable history.
 *
 * The composer now offers a "📋 from history" picker that scans persisted
 * chat bubbles for `[📎 filename](/uploads/<id>)` references and lets the
 * user re-attach them to the next message without re-uploading.
 *
 * This smoke verifies the two contracts the SPA depends on:
 *
 *  A. The pure `extractHistoryAttachments` helper in
 *     apps/web/src/components/history-attachments.ts walks chat texts,
 *     parses the markdown attachment link, and dedupes by uploadId.
 *
 *  B. The relay's `/uploads/:id` route supports HEAD with correct
 *     Content-Type + Content-Length headers, which the SPA reads via
 *     fetch(url, {method:"HEAD"}) before pushing a re-attached chip.
 *     This piggybacks on fastify's auto-HEAD-from-GET.
 *
 * The full re-send round-trip (fetching bytes via GET and base64-encoding
 * for chat.send) is already covered by phaseC4-uploads-test.mjs; we don't
 * re-fetch here.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocket } from "ws";
import { Blob } from "node:buffer";

const here = path.dirname(fileURLToPath(import.meta.url));
const helperModule = path.resolve(here, "../../web/src/components/history-attachments.ts");

let failures = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

// ---------- A. pure-function helper through tsx ----------

const driver = `
import { extractHistoryAttachments } from ${JSON.stringify(helperModule)};

const cases = {};

// 1. Single attachment, single text.
cases.single = extractHistoryAttachments([
  "hey check this out [📎 budget.csv](/uploads/aaaaaa1) — totals are off",
]);

// 2. Three attachments across two texts; dedupes by uploadId; first wins for filename.
cases.multi = extractHistoryAttachments([
  "first [📎 ProjectPlan.pdf](/uploads/abcdef0) and [📎 photo.png](/uploads/aaaaaa1)",
  "again [📎 same-but-renamed.pdf](/uploads/abcdef0) and [📎 fresh.txt](/uploads/cccccc2)",
]);

// 3. Non-uploads links are ignored.
cases.unrelated = extractHistoryAttachments([
  "external [link](https://example.com/foo.png) and [other](/api/whatever)",
]);

// 4. Empty / null inputs.
cases.empty = extractHistoryAttachments([]);
cases.nullText = extractHistoryAttachments([""]);

// 5. Filename has spaces + special chars.
cases.spaces = extractHistoryAttachments([
  "[📎 My File (final).pdf](/uploads/1234567)",
]);

process.stdout.write(JSON.stringify(cases));
`;

const run = spawnSync("npx", ["-y", "tsx", "--eval", driver], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (run.status !== 0) {
  console.error("tsx driver failed:");
  console.error(run.stderr || run.stdout);
  process.exit(2);
}
let cases;
try {
  cases = JSON.parse(run.stdout);
} catch {
  console.error("driver stdout not JSON:");
  console.error(run.stdout);
  process.exit(2);
}

if (cases.single?.length !== 1) fail(`single: expected 1 attachment, got ${cases.single?.length}`);
if (cases.single?.[0]?.uploadId !== "aaaaaa1") fail(`single: bad uploadId ${cases.single?.[0]?.uploadId}`);
if (cases.single?.[0]?.filename !== "budget.csv") fail(`single: bad filename ${cases.single?.[0]?.filename}`);
if (cases.single?.[0]?.url !== "/uploads/aaaaaa1") fail(`single: bad url ${cases.single?.[0]?.url}`);

if (cases.multi?.length !== 3) fail(`multi: expected 3 dedup attachments, got ${cases.multi?.length}`);
const multiIds = (cases.multi ?? []).map((h) => h.uploadId);
if (JSON.stringify(multiIds) !== JSON.stringify(["abcdef0", "aaaaaa1", "cccccc2"])) {
  fail(`multi: wrong order/ids ${JSON.stringify(multiIds)}`);
}
if (cases.multi?.[0]?.filename !== "ProjectPlan.pdf") {
  fail(`multi: first occurrence should win on filename, got ${cases.multi?.[0]?.filename}`);
}

if (cases.unrelated?.length !== 0) fail(`unrelated: expected 0, got ${cases.unrelated?.length}`);
if (cases.empty?.length !== 0) fail(`empty: expected 0, got ${cases.empty?.length}`);
if (cases.nullText?.length !== 0) fail(`nullText: expected 0, got ${cases.nullText?.length}`);

if (cases.spaces?.[0]?.filename !== "My File (final).pdf") {
  fail(`spaces: bad filename ${cases.spaces?.[0]?.filename}`);
}

console.log(`  pure helper: ${failures === 0 ? "ok" : "FAIL"}`);

// ---------- B. /uploads HEAD contract ----------

const RELAY = process.env.CLAW_HQ_RELAY ?? "http://localhost:3838";

async function uploadFixture() {
  // Make a tiny PNG via 1x1 transparent pixel (same trick phaseC4 uses).
  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000160c4830f00000000049454e44ae426082",
    "hex",
  );
  const fd = new FormData();
  fd.append("file", new Blob([pngBytes], { type: "image/png" }), "phaseC37.png");
  const res = await fetch(`${RELAY}/api/uploads`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res.json();
}

async function probeHead(id) {
  const res = await fetch(`${RELAY}/uploads/${id}`, { method: "HEAD" });
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    contentLength: res.headers.get("content-length"),
  };
}

try {
  const up = await uploadFixture();
  console.log(`  uploaded ${up.id.slice(0, 8)}… (${up.size}B)`);
  const head = await probeHead(up.id);
  if (head.status !== 200) fail(`HEAD status ${head.status}, expected 200`);
  // fastify may include a charset suffix — match on prefix.
  if (!head.contentType || !head.contentType.startsWith("image/png")) {
    fail(`HEAD Content-Type bad: ${head.contentType}`);
  }
  if (!head.contentLength || Number(head.contentLength) !== up.size) {
    fail(`HEAD Content-Length bad: ${head.contentLength} expected ${up.size}`);
  }
  console.log(`  /uploads/${up.id.slice(0, 8)} HEAD ok (${head.contentType}, ${head.contentLength}B)`);
} catch (e) {
  fail(`upload+HEAD smoke threw: ${e?.message ?? e}`);
}

if (failures > 0) {
  console.error(`\n  ${failures} failure(s)\n`);
  process.exit(1);
}
console.log(`\n  Result: re-attachable history contract ok\n`);
process.exit(0);
