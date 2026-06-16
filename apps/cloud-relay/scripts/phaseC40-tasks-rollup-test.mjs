#!/usr/bin/env node
/**
 * Phase C step 40 smoke — global /tasks rollup.
 *
 * Builds a synthetic workspace with three flavors of TASKS.md (project root,
 * sub-project, and one with frontmatter on BRIEF.md) and exercises
 * listAllTasks directly. Also locks the SPA + plugin wiring.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ── Plugin wiring ──────────────────────────────────────────────────────────
const tasks = readFileSync(resolve(REPO, "apps/openclaw-plugin/src/tasks.ts"), "utf-8");
ok(tasks.includes("export async function listAllTasks"), "tasks.ts exports listAllTasks");
ok(tasks.includes("interface RollupResult"), "RollupResult shape defined");
ok(tasks.includes("collectTaskLines"), "collectTaskLines helper present");
ok(tasks.includes("nameFromBrief"), "nameFromBrief helper present");
ok(tasks.includes("SKIP_DIRS"), "tasks rollup respects SKIP_DIRS");

const idx = readFileSync(resolve(REPO, "apps/openclaw-plugin/src/index.ts"), "utf-8");
ok(idx.includes('PLUGIN_VERSION = "0.0.16"'), "Plugin version bumped to 0.0.16");
ok(idx.includes('"clawhq.tasks.listAll"'), "Plugin registers clawhq.tasks.listAll");
ok(idx.includes("await listAllTasks({ workspaceRoot })"), "listAll wired to listAllTasks");

// ── SPA wiring ─────────────────────────────────────────────────────────────
const sidebar = readFileSync(resolve(REPO, "apps/web/src/components/Sidebar.tsx"), "utf-8");
ok(sidebar.includes('| "tasks"'), "Sidebar SidebarPage union includes \"tasks\"");
ok(/id:\s*"tasks"/.test(sidebar), "Sidebar STATIC_NAV registers tasks row");

const chatApp = readFileSync(resolve(REPO, "apps/web/src/components/ChatApp.tsx"), "utf-8");
ok(chatApp.includes("./pages/TasksPage.js"), "ChatApp imports TasksPage");
ok(/page\s*===\s*"tasks"\s*&&\s*<TasksPage/.test(chatApp), "ChatApp renders TasksPage on tasks page");
ok(/"\/tasks":\s*"tasks"/.test(chatApp), "Deep link /tasks → tasks page");

const page = readFileSync(resolve(REPO, "apps/web/src/components/pages/TasksPage.tsx"), "utf-8");
ok(page.includes('"clawhq.tasks.listAll"'), "TasksPage loads via clawhq.tasks.listAll");
ok(page.includes('"clawhq.tasks.toggle"'), "TasksPage toggles via clawhq.tasks.toggle");
ok(page.includes("optimistic"), "TasksPage flips optimistically");

// ── Behavioural test via dynamic import of tasks.ts (tsx) ──────────────────
const work = mkdtempSync(resolve(tmpdir(), "phaseC40-"));
const root = resolve(work, "workspace");
mkdirSync(resolve(root, "projects", "alpha", "subprojects", "tax-stuff"), { recursive: true });
mkdirSync(resolve(root, "projects", "beta-test"), { recursive: true });
mkdirSync(resolve(root, "projects", "secrets"), { recursive: true }); // SKIP dir, gets ignored

writeFileSync(
  resolve(root, "projects", "alpha", "BRIEF.md"),
  "# Alpha\n\nA project.\n",
);
writeFileSync(
  resolve(root, "projects", "alpha", "TASKS.md"),
  "- [ ] root task A\n- [x] root task B\nNot a checkbox\n",
);
writeFileSync(
  resolve(root, "projects", "alpha", "subprojects", "tax-stuff", "BRIEF.md"),
  "---\nname: Tax stuff\nstatus: active\n---\n# Fallback\n",
);
writeFileSync(
  resolve(root, "projects", "alpha", "subprojects", "tax-stuff", "TASKS.md"),
  "- [ ] file 1099\n- [ ] file W-2\n- [x] file W-9\n",
);
writeFileSync(
  resolve(root, "projects", "beta-test", "BRIEF.md"),
  "# Beta Test\n",
);
writeFileSync(
  resolve(root, "projects", "beta-test", "TASKS.md"),
  "- [x] ship it\n",
);
writeFileSync(
  resolve(root, "projects", "secrets", "TASKS.md"),
  "- [ ] should not appear\n",
);

const { listAllTasks } = await import(resolve(REPO, "apps/openclaw-plugin/src/tasks.ts"));
const result = await listAllTasks({ workspaceRoot: root });

ok(result.projectsScanned === 2, `2 projects scanned (got ${result.projectsScanned}); secrets/ skipped`);
ok(result.filesRead === 3, `3 TASKS.md files read (got ${result.filesRead})`);
ok(result.tasks.length === 6, `6 task lines aggregated (got ${result.tasks.length})`);

const alphaRoot = result.tasks.filter(
  (t) => t.projectSlug === "alpha" && t.subprojectSlug === null,
);
ok(alphaRoot.length === 2, "alpha root has 2 tasks");
ok(alphaRoot[0].text === "root task A", "first alpha task text preserved");
ok(alphaRoot[0].checked === false, "first alpha task is open");
ok(alphaRoot[1].checked === true, "second alpha task is done");
ok(alphaRoot[0].projectName === "Alpha", "project name pulled from BRIEF H1");

const tax = result.tasks.filter(
  (t) => t.projectSlug === "alpha" && t.subprojectSlug === "tax-stuff",
);
ok(tax.length === 3, "tax-stuff has 3 tasks");
ok(tax[0].subprojectName === "Tax stuff", "subproject name pulled from frontmatter");
ok(
  tax[0].lineIndex === 0 && tax[1].lineIndex === 1 && tax[2].lineIndex === 2,
  "tax-stuff lineIndex 0..2 (per-file, not global)",
);

const beta = result.tasks.filter((t) => t.projectSlug === "beta-test");
ok(beta.length === 1, "beta-test has 1 task");
ok(beta[0].checked === true, "beta-test task is done");

const fromSecrets = result.tasks.filter((t) => t.projectSlug === "secrets");
ok(fromSecrets.length === 0, "secrets project skipped (SKIP_DIRS)");

rmSync(work, { recursive: true, force: true });

console.log(`\n✓ phaseC40 (tasks rollup) — ${assertions} assertions`);
