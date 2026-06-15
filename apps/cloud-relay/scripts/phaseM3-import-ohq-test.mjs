#!/usr/bin/env node
/**
 * Smoke test for the OHQ-migration Day 2 import-ohq CLI command.
 *
 * Builds a synthetic OHQ source dir in a tmp workspace, runs the CLI in
 * dry-run + live modes against tmp target dirs (via CLAW_HQ_CONFIG +
 * HOME redirection), then asserts:
 *
 *   1. dry-run prints chat summary, no files written
 *   2. live mode writes the chat JSON in Claw HQ shape
 *   3. tool-use + tool-result pair collapsed into single "tool" entry
 *   4. user attachments rewritten to /uploads/<sha> + blob copied to uploads dir
 *   5. attachment meta sidecar written
 *   6. content-addressed dedup — same bytes referenced twice = one blob
 *   7. existing chat not overwritten without --force
 *   8. --force allows overwrite
 *   9. --chat filter limits import to one
 *  10. --project filter limits import by project slug
 *  11. unknown source dir errors out
 *
 * Pure file-system test. Does NOT touch the live relay or Frank's data.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(HERE, "../../cli/src/index.ts");

const work = mkdtempSync(resolve(tmpdir(), "phaseM3-"));
const sourceDir = resolve(work, "src-workspace");
const home = resolve(work, "fake-home");
const dataDir = resolve(home, ".claw-hq");
const targetChatsDir = resolve(home, ".openclaw", "clawhq", "data", "chats");
const targetUploadsDir = resolve(dataDir, "uploads");

mkdirSync(resolve(sourceDir, ".oswald-hq", "chats"), { recursive: true });
mkdirSync(resolve(sourceDir, ".oswald-hq", "uploads"), { recursive: true });
mkdirSync(dataDir, { recursive: true });

// Synthetic config so the CLI's readConfig() picks our tmp dataDir.
const cfgPath = resolve(home, "claw-hq-config.json");
writeFileSync(
  cfgPath,
  JSON.stringify(
    {
      port: 9999,
      host: "127.0.0.1",
      publicUrl: "http://localhost:9999",
      run: { relay: true, tunnel: true },
      auth: { mode: "trusted-lan" },
      tunnel: { relayUrl: "in-process", openclawConfigPath: "/tmp/fake-openclaw.json" },
      dataDir,
      webDistPath: "/tmp/fake-web-dist",
    },
    null,
    2,
  ),
);

// ── Synthetic OHQ chats ──────────────────────────────────────────────────────
const CHAT_A_ID = "11111111-2222-3333-4444-555555555555";
const CHAT_B_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CHAT_C_ID = "99999999-8888-7777-6666-555555555555";

// chat A: user with image attachment + tool-use/result pair + assistant
const imgBytesA = Buffer.from("PNGBYTES-A-fake", "utf-8");
const imgShaA = createHash("sha256").update(imgBytesA).digest("hex");
mkdirSync(resolve(sourceDir, ".oswald-hq", "uploads", CHAT_A_ID), { recursive: true });
writeFileSync(resolve(sourceDir, ".oswald-hq", "uploads", CHAT_A_ID, "abc.png"), imgBytesA);

const chatA = {
  id: CHAT_A_ID,
  title: "Test chat A",
  project: "pm-hq",
  createdAt: "2026-06-01T12:00:00.000Z",
  updatedAt: "2026-06-01T12:05:00.000Z",
  claudeSessionId: null,
  messages: [
    {
      kind: "user",
      text: "Look at this image",
      images: [`/api/chats/${CHAT_A_ID}/attachments/abc.png`],
    },
    { kind: "tool-use", name: "Read", summary: "reading file" },
    { kind: "tool-result", ok: true, summary: "read 42 lines" },
    { kind: "assistant-text", text: "OK done" },
    { kind: "system", text: "done · 6→41 tok · $0.06", ctxPct: 12.94 },
  ],
};
writeFileSync(
  resolve(sourceDir, ".oswald-hq", "chats", `${CHAT_A_ID}.json`),
  JSON.stringify(chatA, null, 2),
);

// chat B: no project, ask-question + error blocks
const chatB = {
  id: CHAT_B_ID,
  title: "Test chat B",
  project: null,
  createdAt: "2026-06-02T08:00:00.000Z",
  updatedAt: "2026-06-02T08:01:00.000Z",
  claudeSessionId: null,
  messages: [
    { kind: "user", text: "Pick one" },
    {
      kind: "ask-question",
      questions: [
        {
          question: "Which color?",
          options: [{ label: "red" }, { label: "blue" }],
        },
      ],
    },
    { kind: "error", text: "boom" },
  ],
};
writeFileSync(
  resolve(sourceDir, ".oswald-hq", "chats", `${CHAT_B_ID}.json`),
  JSON.stringify(chatB, null, 2),
);

// chat C: dup-bytes attachment (same image as chat A → should dedupe)
mkdirSync(resolve(sourceDir, ".oswald-hq", "uploads", CHAT_C_ID), { recursive: true });
writeFileSync(resolve(sourceDir, ".oswald-hq", "uploads", CHAT_C_ID, "xyz.png"), imgBytesA);
const chatC = {
  id: CHAT_C_ID,
  title: "Test chat C",
  project: "pm-hq",
  createdAt: "2026-06-03T08:00:00.000Z",
  updatedAt: "2026-06-03T08:01:00.000Z",
  claudeSessionId: null,
  messages: [
    {
      kind: "user",
      text: "same image, different chat",
      images: [`/api/chats/${CHAT_C_ID}/attachments/xyz.png`],
    },
  ],
};
writeFileSync(
  resolve(sourceDir, ".oswald-hq", "chats", `${CHAT_C_ID}.json`),
  JSON.stringify(chatC, null, 2),
);

// Drop a .corrupt.bak that must be skipped.
writeFileSync(
  resolve(sourceDir, ".oswald-hq", "chats", "deadbeef.json.corrupt.bak"),
  "not json",
);

// ── Run helper ──────────────────────────────────────────────────────────────

function runCli(args, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: home,
    CLAW_HQ_CONFIG: cfgPath,
    ...extraEnv,
  };
  const r = spawnSync(
    "node",
    ["--import", "tsx/esm", CLI_ENTRY, "import-ohq", ...args],
    { env, encoding: "utf-8" },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

let assertions = 0;
function ok(cond, msg) {
  assertions++;
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    console.error("  workdir:", work);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

// 1. Dry-run produces summary, writes nothing.
{
  const before = existsSync(targetChatsDir) ? readdirSync(targetChatsDir).length : 0;
  const r = runCli([sourceDir]);
  ok(r.code === 0, "dry-run exits 0");
  ok(r.stdout.includes("DRY-RUN"), "dry-run banner");
  ok(r.stdout.includes("Test chat A"), "dry-run lists chat A");
  ok(r.stdout.includes("Test chat B"), "dry-run lists chat B");
  ok(r.stdout.includes("Test chat C"), "dry-run lists chat C");
  ok(!r.stdout.includes("corrupt"), "corrupt.bak silently skipped");
  const after = existsSync(targetChatsDir) ? readdirSync(targetChatsDir).length : 0;
  ok(before === after, "dry-run wrote zero files");
}

// 2. Live mode writes chat JSONs.
{
  const r = runCli([sourceDir, "--live"]);
  ok(r.code === 0, "live exits 0");
  ok(existsSync(resolve(targetChatsDir, `${CHAT_A_ID}.json`)), "chat A written");
  ok(existsSync(resolve(targetChatsDir, `${CHAT_B_ID}.json`)), "chat B written");
  ok(existsSync(resolve(targetChatsDir, `${CHAT_C_ID}.json`)), "chat C written");
}

// 3. Chat A shape — Claw HQ schema, tool pair collapsed.
{
  const c = JSON.parse(readFileSync(resolve(targetChatsDir, `${CHAT_A_ID}.json`), "utf-8"));
  ok(c.id === CHAT_A_ID, "chat A id preserved");
  ok(c.projectSlug === "pm-hq", "project → projectSlug");
  ok(typeof c.createdMs === "number" && c.createdMs > 0, "createdMs numeric");
  ok(c.updatedMs >= c.createdMs, "updatedMs ≥ createdMs");
  ok(Array.isArray(c.messages), "messages array");
  // Original blocks: user, tool-use, tool-result, assistant-text, system → 4 entries
  ok(c.messages.length === 4, `tool pair collapsed (got ${c.messages.length}, want 4)`);
  ok(c.messages[0].role === "user", "user first");
  ok(c.messages[1].role === "tool", "tool second (paired)");
  const toolPayload = JSON.parse(c.messages[1].content);
  ok(toolPayload.name === "Read", "tool name preserved");
  ok(toolPayload.result === "read 42 lines", "tool result summary preserved");
  ok(toolPayload.isError === false, "tool ok → isError=false");
  ok(c.messages[2].role === "assistant", "assistant third");
  ok(c.messages[3].role === "system", "system fourth");
  ok(c.messages[3].content.includes("ctx"), "system ctx% suffix appended");
}

// 4 + 5. Attachment rewrite + blob + meta.
{
  const c = JSON.parse(readFileSync(resolve(targetChatsDir, `${CHAT_A_ID}.json`), "utf-8"));
  const userBody = c.messages[0].content;
  ok(userBody.startsWith("Look at this image"), "user text preserved");
  ok(userBody.includes(`/uploads/${imgShaA}`), "user attachment URL rewritten to /uploads/<sha>");
  const blob = resolve(targetUploadsDir, `${imgShaA}.png`);
  const meta = resolve(targetUploadsDir, `${imgShaA}.meta.json`);
  ok(existsSync(blob), "blob written");
  ok(existsSync(meta), "meta sidecar written");
  const metaObj = JSON.parse(readFileSync(meta, "utf-8"));
  ok(metaObj.mimeType === "image/png", "mime inferred from .png");
  ok(metaObj.size === imgBytesA.length, "meta size matches bytes");
}

// 6. Dedup — chat A + chat C reference same bytes, only one blob on disk.
{
  const entries = readdirSync(targetUploadsDir).filter(
    (f) => f.startsWith(imgShaA) && !f.endsWith(".meta.json"),
  );
  ok(entries.length === 1, `single blob for dup bytes (got ${entries.length})`);
}

// 7. Re-run without --force does NOT overwrite.
{
  // Sentinel: trash the file so a re-import would visibly overwrite if it did.
  const p = resolve(targetChatsDir, `${CHAT_A_ID}.json`);
  writeFileSync(p, '{"sentinel":true}');
  const r = runCli([sourceDir, "--live"]);
  ok(r.code === 0, "re-run live exits 0");
  ok(r.stdout.includes("SKIP — exists"), "skip notice for existing chats");
  const c = JSON.parse(readFileSync(p, "utf-8"));
  ok(c.sentinel === true, "sentinel file untouched (no overwrite)");
}

// 8. --force overwrites.
{
  const r = runCli([sourceDir, "--live", "--force", "--chat", CHAT_A_ID]);
  ok(r.code === 0, "force exits 0");
  const c = JSON.parse(readFileSync(resolve(targetChatsDir, `${CHAT_A_ID}.json`), "utf-8"));
  ok(c.id === CHAT_A_ID && Array.isArray(c.messages), "force overwrote sentinel with real chat");
}

// 9. --chat filter.
{
  const r = runCli([sourceDir, "--chat", CHAT_B_ID]);
  ok(r.code === 0, "filter exits 0");
  ok(r.stdout.includes("Test chat B"), "filter shows B");
  ok(!r.stdout.includes("Test chat A"), "filter hides A");
  ok(!r.stdout.includes("Test chat C"), "filter hides C");
}

// 10. --project filter (slug + "none").
{
  const r1 = runCli([sourceDir, "--project", "pm-hq"]);
  ok(r1.stdout.includes("Test chat A"), "project=pm-hq shows A");
  ok(r1.stdout.includes("Test chat C"), "project=pm-hq shows C");
  ok(!r1.stdout.includes("Test chat B"), "project=pm-hq hides B");

  const r2 = runCli([sourceDir, "--project", "none"]);
  ok(r2.stdout.includes("Test chat B"), "project=none shows B");
  ok(!r2.stdout.includes("Test chat A"), "project=none hides A");
}

// 11. Unknown source dir errors out.
{
  const r = runCli(["/tmp/does-not-exist-phaseM3"]);
  ok(r.code !== 0, "missing source exits non-zero");
}

// 12. Chat B ask-question + error block translation.
{
  const c = JSON.parse(readFileSync(resolve(targetChatsDir, `${CHAT_B_ID}.json`), "utf-8"));
  ok(c.messages.length === 3, "B has 3 messages");
  ok(c.messages[0].role === "user", "B user first");
  ok(c.messages[1].role === "system", "ask-question → system");
  ok(c.messages[1].content.includes("Which color?"), "question text preserved");
  ok(c.messages[1].content.includes("• red"), "question option labels preserved");
  ok(c.messages[2].role === "system", "error → system");
  ok(c.messages[2].content.startsWith("[error]"), "error tagged");
}

console.log(`\n✓ phaseM3 (import-ohq) — ${assertions} assertions`);
rmSync(work, { recursive: true, force: true });
