#!/usr/bin/env node
/**
 * Phase C step 49 — emojis out, stylized SVG icons in.
 *
 * Frank: "Get rid of every emoji in Claw HQ. Replace them with stylized
 * minimalist icons instead."
 *
 * Strategy: central icons.tsx library of lucide-stroke-style inline SVGs.
 * Every emoji UI site gets the matching icon component. Two exceptions:
 *   - 📎 in chat-history attachment serialization (kept for back-compat with
 *     imported OHQ chats — UI strips it on render).
 *   - Typography that isn't emoji (—, …, ·, °, →, curly quotes, NBSP).
 *
 * Asserts the icon library exists, every previously-emoji site now imports
 * from icons.js, and zero emoji glyphs remain in non-data source positions.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SRC = resolve(REPO, "apps/web/src");

const icons = readFileSync(resolve(SRC, "components/icons.tsx"), "utf-8");

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

console.log("Phase C step 49 — emojis out, SVG icons in");

// Icon library — load-bearing exports.
const requiredIcons = [
  "Home", "Leaf", "Check", "Books", "Folder", "Document", "Brain", "Tools",
  "Models", "Hand", "Clock", "Phone", "Settings", "Stethoscope", "Plug",
  "Plus", "Mic", "Clip", "Clipboard", "Image", "Chat", "Pencil",
  "Bell", "Menu", "X", "Kebab", "Chevron", "Hourglass", "Warning", "Lock",
  "ArrowUp", "ArrowRight",
];
for (const name of requiredIcons) {
  ok(
    new RegExp(`export const ${name}\\s*[=:]`).test(icons) ||
      new RegExp(`export const ${name}\\s*=\\s*\\(`).test(icons),
    `icons.tsx exports ${name}`,
  );
}
ok(
  /stroke="currentColor"/.test(icons),
  "icons inherit color via stroke=currentColor",
);
ok(
  /strokeWidth=\{2\}/.test(icons),
  "icons use stroke-width 2 (lucide style)",
);

// Walk apps/web/src and assert no emoji codepoints remain outside the data
// allowlist (📎 in attachment serialization).
const EMOJI_RE = /[\u{1F000}-\u{1FFFF}\u{2300}-\u{23FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
const ALLOWLIST = new Set([
  // back-compat with OHQ-imported chats; UI strips 📎 on render.
  "components/history-attachments.ts",
  // The sender uses [📎 filename](/uploads/<id>); same back-compat.
  "components/ChatDetailView.tsx",
]);
const offenders = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) { walk(p); continue; }
    if (!/\.(tsx?|ts)$/.test(entry)) continue;
    const rel = p.slice(SRC.length + 1);
    if (ALLOWLIST.has(rel)) continue;
    const t = readFileSync(p, "utf-8");
    const lines = t.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (EMOJI_RE.test(lines[i])) {
        offenders.push(`${rel}:${i + 1}  ${lines[i].trim().slice(0, 100)}`);
      }
    }
  }
}
walk(SRC);

ok(
  offenders.length === 0,
  offenders.length === 0
    ? "no emoji codepoints in non-allowlisted source files"
    : `emoji glyphs remain:\n    ${offenders.join("\n    ")}`,
);

// Spot-check load-bearing sites are now icon-driven.
const sidebar = readFileSync(resolve(SRC, "components/Sidebar.tsx"), "utf-8");
ok(
  /import \{[^}]*\bHome\b[^}]*\bLeaf\b/.test(sidebar) ||
    /from "\.\/icons\.js"/.test(sidebar),
  "Sidebar imports from icons.js",
);
ok(
  /icon:\s*<Home \/>/.test(sidebar),
  "Sidebar STATIC_NAV uses <Home /> JSX (no emoji strings)",
);

const chatApp = readFileSync(resolve(SRC, "components/ChatApp.tsx"), "utf-8");
ok(
  /<Bell size=/.test(chatApp),
  "ChatApp bell icon is <Bell />",
);
ok(
  /<Menu size=/.test(chatApp),
  "ChatApp hamburger is <Menu />",
);

const chatDetail = readFileSync(resolve(SRC, "components/ChatDetailView.tsx"), "utf-8");
ok(
  /<Plus size=/.test(chatDetail),
  "ChatDetailView composer + is <Plus />",
);
ok(
  /<Mic size=/.test(chatDetail),
  "ChatDetailView mic is <Mic />",
);
ok(
  /<ArrowUp size=/.test(chatDetail),
  "ChatDetailView send arrow is <ArrowUp />",
);
ok(
  /const isAttachment = p\.text\.startsWith\("📎"\)/.test(chatDetail),
  "BubbleContent detects 📎 link labels for emoji-free rendering",
);
ok(
  /<Clip size=/.test(chatDetail),
  "BubbleContent prepends <Clip /> for attachment links",
);

console.log(`\nphaseC49: ${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
