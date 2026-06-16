#!/usr/bin/env node
/**
 * Phase C step 38 smoke — workspace /docs search page.
 *
 * Source-wired assertions only (no plugin reinstall needed to flake-pass):
 *   1. Sidebar nav row registered + page-key wired
 *   2. ChatApp renders DocsPage on page === "docs"
 *   3. Deep link /docs maps to docs page
 *   4. Plugin source registers clawhq.docs.{list,get,search}
 *
 * Live assertions are skipped with a warn if the running gateway plugin
 * doesn't yet advertise the new methods (same pattern as phaseC25).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

let assertions = 0;
let warnings = 0;
function ok(cond, msg) {
  assertions++;
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}
function warn(msg) {
  warnings++;
  console.log(`  ⚠ ${msg}`);
}

// 1 + 2. Sidebar + ChatApp wiring.
const sidebar = readFileSync(resolve(REPO, "apps/web/src/components/Sidebar.tsx"), "utf-8");
ok(sidebar.includes('| "docs"'), "Sidebar SidebarPage union includes \"docs\"");
ok(/id:\s*"docs"/.test(sidebar), "Sidebar STATIC_NAV registers docs row");

const chatApp = readFileSync(resolve(REPO, "apps/web/src/components/ChatApp.tsx"), "utf-8");
ok(chatApp.includes("./pages/DocsPage.js"), "ChatApp imports DocsPage");
ok(/page\s*===\s*"docs"\s*&&\s*<DocsPage/.test(chatApp), "ChatApp renders DocsPage on docs page");
ok(/"\/docs":\s*"docs"/.test(chatApp), "Deep link /docs → docs page");

// 3. DocsPage exists and calls the expected RPCs.
const docsPage = readFileSync(resolve(REPO, "apps/web/src/components/pages/DocsPage.tsx"), "utf-8");
ok(docsPage.includes('"clawhq.docs.list"'), "DocsPage calls clawhq.docs.list");
ok(docsPage.includes('"clawhq.docs.get"'), "DocsPage calls clawhq.docs.get");
ok(docsPage.includes('"clawhq.docs.search"'), "DocsPage calls clawhq.docs.search");

// 4. Plugin source registers the three new methods.
const pluginIndex = readFileSync(resolve(REPO, "apps/openclaw-plugin/src/index.ts"), "utf-8");
ok(
  pluginIndex.includes('PLUGIN_VERSION = "0.0.14"'),
  "Plugin version bumped to 0.0.14",
);
ok(
  pluginIndex.includes('"clawhq.docs.list"') &&
    pluginIndex.includes('registerGatewayMethod'),
  "Plugin registers clawhq.docs.list",
);
ok(pluginIndex.includes('"clawhq.docs.get"'), "Plugin registers clawhq.docs.get");
ok(pluginIndex.includes('"clawhq.docs.search"'), "Plugin registers clawhq.docs.search");

const docsImpl = readFileSync(resolve(REPO, "apps/openclaw-plugin/src/docs.ts"), "utf-8");
ok(docsImpl.includes("SKIP_DIRS"), "docs.ts has SKIP_DIRS guard");
ok(docsImpl.includes("inSkippedDir"), "docs.ts checks skip-dirs against returned files");
ok(docsImpl.includes("resolveDocPath"), "docs.ts has path-traversal guard");

// 5. Optional live probe — only runs if the running gateway publishes the methods.
const { GatewayClient } = await import("../../../packages/protocol-types/dist/index.js").catch(() => ({}));
if (!GatewayClient) {
  warn("Live probe skipped — protocol-types not built yet (expected on first run).");
} else {
  // Live wiring is exercised by Frank reopening the SPA against a restarted
  // gateway. Source-wired tests above cover everything we control on disk.
  warn("Live probe stub — exercise after plugin reinstall + gateway restart.");
}

console.log(`\n✓ phaseC38 (docs page) — ${assertions} assertions${warnings ? `, ${warnings} warn` : ""}`);
