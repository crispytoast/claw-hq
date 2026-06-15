#!/usr/bin/env node
/**
 * Phase C step 24 smoke test — line-diff helpers used by ChatDetailView render
 * Edit / Write / MultiEdit tool calls as a real unified diff instead of raw
 * args JSON. The diff helpers live in apps/web/src/components/diff.ts and are
 * pure (no React imports), so we drive them through tsx and assert the shape.
 *
 *   1. Edit with surrounding context collapses to a single hunk with +/− lines.
 *   2. Write returns a single "new-file" diff with all + lines.
 *   3. MultiEdit returns one ParsedFileEdit per edits[] entry.
 *   4. Pure rename (old===new) yields zero hunks.
 *   5. The hard cap on cross-product is respected (no OOM on adversarial input).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const diffModule = path.resolve(here, "../../web/src/components/diff.ts");

const driver = `
import { lineDiff, statsFor, toHunks, parseFileEditArgs } from ${JSON.stringify(diffModule)};

const cases = {};

// 1. Edit hunk: change line 3 of a 5-line file.
const before = "alpha\\nbeta\\ngamma\\ndelta\\nepsilon";
const after  = "alpha\\nbeta\\nGAMMA\\ndelta\\nepsilon";
const lines = lineDiff(before, after);
const hunks = toHunks(lines);
cases.editStats = statsFor(lines);
cases.editHunkCount = hunks.length;
cases.editFirstHunkLineCount = hunks[0]?.lines.length ?? 0;

// 2. Write — new file all-additions.
const writeEdits = parseFileEditArgs("Write", { file_path: "/tmp/foo.ts", content: "line1\\nline2\\nline3" });
cases.writeMode = writeEdits?.[0]?.mode;
cases.writeStats = writeEdits ? statsFor(lineDiff(writeEdits[0].before, writeEdits[0].after)) : null;

// 3. MultiEdit — 2 edits in the same file.
const multi = parseFileEditArgs("MultiEdit", {
  file_path: "/tmp/foo.ts",
  edits: [
    { old_string: "foo", new_string: "FOO" },
    { old_string: "bar", new_string: "BAR" },
  ],
});
cases.multiCount = multi?.length ?? 0;

// 4. Identity — no changes -> no hunks.
const noopHunks = toHunks(lineDiff("same\\nlines", "same\\nlines"));
cases.noopHunks = noopHunks.length;

// 5. Adversarial size — 600 x 600 disjoint lines should NOT crash; diff exists.
const bigOld = Array.from({ length: 600 }, (_, i) => "old_" + i).join("\\n");
const bigNew = Array.from({ length: 600 }, (_, i) => "new_" + i).join("\\n");
const bigLines = lineDiff(bigOld, bigNew);
cases.bigDiffNonEmpty = bigLines.length > 0;

// 6. parseFileEditArgs rejects unknown tool.
cases.unknownTool = parseFileEditArgs("Bash", { command: "ls" });

// 7. Edit with empty new_string still parses (deletion).
const delEdit = parseFileEditArgs("Edit", { file_path: "/a", old_string: "x", new_string: "" });
cases.deletionParsed = Array.isArray(delEdit) && delEdit.length === 1;

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
} catch (e) {
  console.error("driver stdout not JSON:");
  console.error(run.stdout);
  process.exit(2);
}

let failures = 0;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };

if (cases.editStats?.added !== 1) fail(`edit added: ${JSON.stringify(cases.editStats)}`);
if (cases.editStats?.deleted !== 1) fail(`edit deleted: ${JSON.stringify(cases.editStats)}`);
if (cases.editHunkCount !== 1) fail(`expected 1 hunk for tiny edit, got ${cases.editHunkCount}`);
if (cases.editFirstHunkLineCount < 4) fail(`hunk should include context, got ${cases.editFirstHunkLineCount} lines`);

if (cases.writeMode !== "new-file") fail(`write mode: ${cases.writeMode}`);
if (cases.writeStats?.added !== 3) fail(`write add count: ${JSON.stringify(cases.writeStats)}`);
if (cases.writeStats?.deleted !== 0) fail(`write should have 0 deletes: ${JSON.stringify(cases.writeStats)}`);

if (cases.multiCount !== 2) fail(`multi-edit count: ${cases.multiCount}`);

if (cases.noopHunks !== 0) fail(`identity diff should produce 0 hunks, got ${cases.noopHunks}`);

if (!cases.bigDiffNonEmpty) fail("600x600 diff produced empty output");

if (cases.unknownTool !== null) fail(`Bash should return null, got ${JSON.stringify(cases.unknownTool)}`);
if (!cases.deletionParsed) fail("empty new_string should still parse as a deletion edit");

if (failures > 0) {
  console.error(`\n  ${failures} failure(s)\n`);
  process.exit(1);
}
console.log(`\n  Result: line-diff helpers OK across Edit / Write / MultiEdit / identity / oversized cases\n`);
process.exit(0);
