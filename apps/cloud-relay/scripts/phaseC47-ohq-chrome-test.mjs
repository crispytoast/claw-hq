#!/usr/bin/env node
/**
 * Phase C step 47 — close the OHQ chrome gap.
 *
 * Three structural changes Frank flagged after step 46 ("It's closer..."):
 *   1. Composer dropped from 4 buttons (+, mic, history, model) to OHQ's
 *      2-button default (+, model). Mic + history live behind a "⋯" kebab
 *      that only renders when the underlying features are present.
 *   2. Top header bell collapsed from emoji+9+ pill to icon-only with a tiny
 *      accent dot; "● online" pill replaced by a small colored status dot.
 *   3. Sub-header title dimmed to --muted-foreground; user bubble drops the
 *      asymmetric border-bottom-right-radius for OHQ's uniform rounded-2xl.
 *
 * Source-aware smoke. No live relay needed.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const chatTsx = readFileSync(
  resolve(REPO, "apps/web/src/components/ChatDetailView.tsx"),
  "utf-8",
);
const chatApp = readFileSync(
  resolve(REPO, "apps/web/src/components/ChatApp.tsx"),
  "utf-8",
);
const css = readFileSync(
  resolve(REPO, "apps/web/src/styles.css"),
  "utf-8",
);

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

console.log("Phase C step 47 — OHQ chrome convergence");

// 1. Composer extras kebab.
ok(
  /const \[extrasOpen, setExtrasOpen\] = useState\(false\)/.test(chatTsx),
  "extrasOpen state declared",
);
ok(
  /className=\{`composer-extras-toggle/.test(chatTsx),
  "composer-extras-toggle button rendered",
);
ok(
  /extrasOpen && voiceAvailable/.test(chatTsx),
  "mic button gated by extrasOpen",
);
ok(
  /extrasOpen && historyAttachments\.length > 0/.test(chatTsx),
  "history button gated by extrasOpen",
);
ok(
  /\(voiceAvailable \|\| historyAttachments\.length > 0\)/.test(chatTsx),
  "kebab only renders when at least one extra is available",
);
ok(
  /\.composer-extras-toggle \{/.test(css),
  ".composer-extras-toggle CSS rule defined",
);
ok(
  /\.composer-extras-toggle\.active \{/.test(css) ||
    /\.composer-extras-toggle:hover:not\(:disabled\),\s*\.composer-extras-toggle\.active/.test(css),
  ".composer-extras-toggle active state styled",
);

// 2. Top header compaction.
ok(
  /className="bell-btn-compact"/.test(chatApp),
  "bell-btn-compact replaces bell-btn",
);
ok(
  !/className="bell-btn"\s*\n\s*aria-label="notifications"/.test(chatApp),
  "old loud bell-btn rendering gone from toolbar",
);
ok(
  /className="bell-dot"/.test(chatApp),
  "bell-dot indicator replaces 9+ pill",
);
ok(
  !/className="bell-badge"/.test(chatApp.split("const toolbar")[1] ?? ""),
  "no bell-badge inside the toolbar block",
);
ok(
  /className=\{`status-dot-only/.test(chatApp),
  "status-dot-only replaces status-pill in the toolbar",
);
ok(
  /\.bell-btn-compact \{/.test(css),
  ".bell-btn-compact CSS defined",
);
ok(
  /\.bell-dot \{[\s\S]*?box-shadow:\s*0 0 0 2px var\(--bg\)/.test(css),
  ".bell-dot has bg-color halo to read against bell glyph",
);
ok(
  /\.status-dot-only \{/.test(css) &&
    /\.status-dot-only\.ok \{/.test(css) &&
    /\.status-dot-only\.bad \{/.test(css),
  ".status-dot-only states defined (ok/warn/bad)",
);

// 3. Sub-header dim + bubble symmetric radius.
ok(
  /\.chat-subheader-title \{[\s\S]*?color:\s*var\(--muted-foreground\)/.test(css),
  ".chat-subheader-title dimmed to --muted-foreground",
);
ok(
  !/\.bubble\.user \{[\s\S]*?border-bottom-right-radius:\s*6px/.test(css),
  "user bubble dropped border-bottom-right-radius asymmetry",
);

console.log(`\nphaseC47: ${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
