#!/usr/bin/env node
/**
 * Phase C step 41 smoke — home dashboard.
 *
 * Source-wired only — HomePage is pure composition over existing RPCs that
 * already ship their own coverage. Asserts:
 *   1. Sidebar STATIC_NAV row for home + page-key union entry
 *   2. ChatApp imports + renders HomePage on page === "home"
 *   3. Deep link /home routes correctly
 *   4. HomePage composes the expected six probes (projects/subprojects/
 *      chats/memory/docs/tasks.listAll) and a recent-activity reader
 *   5. Tile clicks call onSelectPage (passed in from ChatApp.handleSelectPage)
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

const sidebar = readFileSync(resolve(REPO, "apps/web/src/components/Sidebar.tsx"), "utf-8");
ok(sidebar.includes('| "home"'), "Sidebar SidebarPage union includes \"home\"");
ok(/id:\s*"home"/.test(sidebar), "Sidebar STATIC_NAV registers home row");

const chatApp = readFileSync(resolve(REPO, "apps/web/src/components/ChatApp.tsx"), "utf-8");
ok(chatApp.includes("./pages/HomePage.js"), "ChatApp imports HomePage");
ok(/page\s*===\s*"home"\s*&&[\s\S]*<HomePage/.test(chatApp), "ChatApp renders HomePage on home page");
ok(/onSelectPage={handleSelectPage}/.test(chatApp), "HomePage receives onSelectPage from ChatApp");
ok(/"\/home":\s*"home"/.test(chatApp), "Deep link /home → home page");

const page = readFileSync(resolve(REPO, "apps/web/src/components/pages/HomePage.tsx"), "utf-8");
for (const rpc of [
  "clawhq.projects.list",
  "clawhq.subprojects.list",
  "clawhq.chats.list",
  "clawhq.memory.list",
  "clawhq.docs.list",
  "clawhq.tasks.listAll",
]) {
  ok(page.includes(`"${rpc}"`), `HomePage probes ${rpc}`);
}
ok(page.includes("onSelectPage(\"subprojects\")"), "Subprojects tile navigates to subprojects");
ok(page.includes("onSelectPage(\"tasks\")"), "Tasks tile navigates to tasks");
ok(page.includes("onSelectPage(\"docs\")"), "Docs tile navigates to docs");
ok(page.includes("onSelectPage(\"memory\")"), "Memory tile navigates to memory");
ok(page.includes("onSelectPage(\"sessions\")"), "Chats tile navigates to sessions");
ok(page.includes("Recent activity"), "Recent activity rail rendered");
ok(/sort\(\(a, b\) => b\.ms - a\.ms\)/.test(page), "Recent activity sorted newest-first");

console.log(`\n✓ phaseC41 (home dashboard) — ${assertions} assertions`);
