#!/usr/bin/env node
/**
 * Phase C step 42 — chat-tier polish.
 *
 * Three independent polish items shipped together:
 *  1. Thinking indicator (3-dot pulse) shown between Send and first response.
 *  2. Fade-in animation on every chat item (bubble, tool, approval, question).
 *  3. Streaming caret replaces the post-bubble spinner during deltas.
 *
 * Source-aware smoke. Asserts the JSX hooks + CSS rules + reduced-motion guard
 * are all in source. Runs without touching a live relay.
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

console.log("Phase C step 42 — chat-tier polish source checks");

// JSX wiring.
ok(
  chatTsx.includes("const showThinking = ("),
  "ChatDetailView computes showThinking from pending + items tail",
);
ok(
  /className="thinking-indicator"/.test(chatTsx),
  "ChatDetailView renders .thinking-indicator block",
);
ok(
  chatTsx.includes('aria-label="agent thinking"'),
  "thinking indicator has aria-label for screen readers",
);
ok(
  /<span \/><span \/><span \/>/.test(chatTsx),
  "thinking indicator has three dots",
);
ok(
  /className="streaming-caret"/.test(chatTsx),
  "ChatDetailView uses .streaming-caret for streaming bubbles",
);
ok(
  !/className="spinner" style=\{\{ marginLeft: "0\.5rem" \}\}/.test(chatTsx),
  "old inline spinner-after-bubble is gone (replaced by caret)",
);

// CSS rules.
ok(
  css.includes("@keyframes chat-item-in"),
  "chat-item-in keyframes defined",
);
ok(
  /\.bubble,\s*\.tool-block,\s*\.approval-block,\s*\.question-block\s*\{\s*animation:\s*chat-item-in/.test(css),
  "fade-in animation applied to all four chat-item classes",
);
ok(
  css.includes(".streaming-caret {"),
  ".streaming-caret class defined",
);
ok(
  css.includes("@keyframes streaming-caret-blink"),
  "streaming-caret-blink keyframes defined",
);
ok(
  css.includes(".thinking-indicator {"),
  ".thinking-indicator class defined",
);
ok(
  css.includes(".thinking-indicator span {"),
  ".thinking-indicator span (dot) class defined",
);
ok(
  css.includes("@keyframes thinking-dot"),
  "thinking-dot keyframes defined",
);
ok(
  /\.thinking-indicator span:nth-child\(2\)\s*\{\s*animation-delay:\s*160ms/.test(css),
  "second dot has stagger delay 160ms",
);
ok(
  /\.thinking-indicator span:nth-child\(3\)\s*\{\s*animation-delay:\s*320ms/.test(css),
  "third dot has stagger delay 320ms",
);

// Accessibility: reduced-motion must disable every animation we added.
ok(
  css.includes("@media (prefers-reduced-motion: reduce)"),
  "prefers-reduced-motion media query present",
);
const reducedBlock = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/);
ok(reducedBlock !== null, "reduced-motion block parseable");
if (reducedBlock) {
  const rb = reducedBlock[0];
  ok(
    /\.bubble.*\.tool-block.*\.approval-block.*\.question-block.*animation:\s*none/s.test(rb),
    "reduced-motion disables fade-in on all four chat-item classes",
  );
  ok(
    /\.streaming-caret\s*\{\s*animation:\s*none/.test(rb),
    "reduced-motion disables streaming caret blink",
  );
  ok(
    /\.thinking-indicator span\s*\{\s*animation:\s*none/.test(rb),
    "reduced-motion disables thinking-indicator dot bounce",
  );
}

// Sanity: showThinking gate logic — must require pending + last item is a user
// message. We don't want the dots to flash after a tool or approval lands.
ok(
  /if \(!pending \|\| items\.length === 0\) return false/.test(chatTsx),
  "showThinking short-circuits when not pending or no items",
);
ok(
  /last\.kind === "message" && last\.message\.role === "user"/.test(chatTsx),
  "showThinking requires the last item to be a user message",
);

console.log(`\nphaseC42: ${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
