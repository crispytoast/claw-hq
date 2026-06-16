#!/usr/bin/env node
/**
 * Phase C step 39 smoke — workspace memory daily browser.
 *
 *   1. Plugin source registers clawhq.memory.longTerm
 *   2. memory.ts exports getLongTermMemory + reads <root>/MEMORY.md
 *      (NOT <root>/memory/MEMORY.md — that one lives at workspace root)
 *   3. Sidebar nav row + page-key wired
 *   4. ChatApp renders WorkspaceMemoryPage on page === "memory"
 *   5. Deep link /memory routes correctly
 *   6. WorkspaceMemoryPage calls the expected RPCs
 *   7. Plugin version bumped to 0.0.15
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

let assertions = 0;
function ok(cond, msg) {
  assertions++;
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

const memorySrc = readFileSync(resolve(REPO, "apps/openclaw-plugin/src/memory.ts"), "utf-8");
ok(memorySrc.includes("export async function getLongTermMemory"), "memory.ts exports getLongTermMemory");
ok(/path\.join\(root,\s*"MEMORY\.md"\)/.test(memorySrc), "getLongTermMemory reads <root>/MEMORY.md");
ok(memorySrc.includes("filePath.startsWith(root + path.sep)"), "long-term path has traversal guard");

const pluginIndex = readFileSync(resolve(REPO, "apps/openclaw-plugin/src/index.ts"), "utf-8");
ok(pluginIndex.includes('PLUGIN_VERSION = "0.0.15"'), "Plugin version bumped to 0.0.15");
ok(pluginIndex.includes('"clawhq.memory.longTerm"'), "Plugin registers clawhq.memory.longTerm");
ok(
  pluginIndex.includes("getLongTermMemory") && pluginIndex.includes('"clawhq.memory.longTerm"'),
  "longTerm method wired to getLongTermMemory",
);

const sidebar = readFileSync(resolve(REPO, "apps/web/src/components/Sidebar.tsx"), "utf-8");
ok(sidebar.includes('| "memory"'), "Sidebar SidebarPage union includes \"memory\"");
ok(/id:\s*"memory"/.test(sidebar), "Sidebar STATIC_NAV registers memory row");

const chatApp = readFileSync(resolve(REPO, "apps/web/src/components/ChatApp.tsx"), "utf-8");
ok(chatApp.includes("./pages/WorkspaceMemoryPage.js"), "ChatApp imports WorkspaceMemoryPage");
ok(/page\s*===\s*"memory"\s*&&\s*<WorkspaceMemoryPage/.test(chatApp), "ChatApp renders page on memory");
ok(/"\/memory":\s*"memory"/.test(chatApp), "Deep link /memory → memory page");

const page = readFileSync(resolve(REPO, "apps/web/src/components/pages/WorkspaceMemoryPage.tsx"), "utf-8");
ok(page.includes('"clawhq.memory.list"'), "WorkspaceMemoryPage calls clawhq.memory.list");
ok(page.includes('"clawhq.memory.get"'), "WorkspaceMemoryPage calls clawhq.memory.get");
ok(page.includes('"clawhq.memory.longTerm"'), "WorkspaceMemoryPage calls clawhq.memory.longTerm");
ok(page.includes("DATE_FILENAME"), "Daily entries filtered by YYYY-MM-DD.md filename regex");
ok(page.includes("groupByMonth"), "Daily entries grouped by month");
ok(page.includes("LONG_TERM_SENTINEL"), "Long-term entry has dedicated sentinel key");

console.log(`\n✓ phaseC39 (workspace memory) — ${assertions} assertions`);
