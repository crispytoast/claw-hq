#!/usr/bin/env node
/**
 * Phase C step 38b — class-name consistency check across the page tier.
 *
 * Catches the class-name typo that bit step 38 (DocsPage used `cl-doc-tree-*`
 * in JSX while the CSS defined `cl-docs-tree-*` — tree rows rendered unstyled).
 *
 * For each new page added in steps 38-41 we enforce: every `cl-<page>-*` class
 * referenced in JSX must match a `.cl-<page>-*` rule in styles.css. Class
 * names that exist purely as wrapping divs without a dedicated CSS rule
 * (used in markup as a hook for descendant rules) are tolerated only if they
 * appear in the EXPECTED_MISSING list below.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const pages = [
  { file: "apps/web/src/components/pages/DocsPage.tsx", prefix: "cl-docs-" },
  { file: "apps/web/src/components/pages/WorkspaceMemoryPage.tsx", prefix: "cl-memory-" },
  { file: "apps/web/src/components/pages/TasksPage.tsx", prefix: "cl-tasks-" },
  { file: "apps/web/src/components/pages/HomePage.tsx", prefix: "cl-home-" },
];

// Classes used as container hooks (descendant selectors handle their styling).
// Keep tight — every entry here is a class with NO direct CSS rule.
const EXPECTED_MISSING = new Set([
  "cl-docs-tree", // wraps tree rows; each row has its own rule
  "cl-docs-tree-file", // marker class; styling comes from cl-docs-tree-row
]);

const css = readFileSync(resolve(REPO, "apps/web/src/styles.css"), "utf-8");

let assertions = 0;
let failures = 0;
function ok(cond, msg) {
  assertions++;
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures++;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

for (const { file, prefix } of pages) {
  const jsx = readFileSync(resolve(REPO, file), "utf-8");
  const inJsx = new Set();
  for (const m of jsx.matchAll(new RegExp(`${prefix}[a-z0-9-]+`, "g"))) {
    inJsx.add(m[0]);
  }
  const inCss = new Set();
  for (const m of css.matchAll(new RegExp(`\\.${prefix}[a-z0-9-]+`, "g"))) {
    inCss.add(m[0].slice(1));
  }
  for (const cls of inJsx) {
    if (inCss.has(cls)) {
      assertions++;
      console.log(`  ✓ ${cls} (matched in CSS)`);
    } else if (EXPECTED_MISSING.has(cls)) {
      assertions++;
      console.log(`  ✓ ${cls} (expected container, no direct rule)`);
    } else {
      ok(false, `${cls} used in ${file.split("/").pop()} JSX but no .${cls} rule in styles.css`);
    }
  }
}

console.log(
  `\n${failures === 0 ? "✓" : "✗"} phaseC38b (class consistency) — ${assertions} assertions${failures ? `, ${failures} FAILED` : ""}`,
);
if (failures) process.exit(1);
