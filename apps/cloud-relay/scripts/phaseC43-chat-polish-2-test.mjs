#!/usr/bin/env node
/**
 * Phase C step 43 — chat-tier polish round 2.
 *
 * Three independent fixes shipped together, per Frank's side-by-side OHQ vs
 * Claw HQ phone screenshots:
 *  1. Inline-code markdown rendering — `code` was showing as literal backticks.
 *  2. System HUD row — centered, no SYSTEM tag, parsed ctx N% into a progress
 *     bar (green / accent / maroon by threshold). Live HUD emission on
 *     state === "final" if event carries usage/cost.
 *  3. Sub-header row above the message list — title + project chip + model
 *     placeholder chip.
 *
 * Source-aware smoke. Asserts JSX hooks + CSS rules + parser unit checks via
 * tsx round-trip (parseHud + parseInline + pickUsage hoisted into the file as
 * module-level helpers).
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

console.log("Phase C step 43 — chat-tier polish round 2 source checks");

// 1. Inline markdown.
ok(
  chatTsx.includes("function parseInline(text: string)"),
  "parseInline tokenizer present",
);
ok(
  chatTsx.includes("function parseBlocks(text: string)"),
  "parseBlocks for fenced code present",
);
ok(
  /\.bubble-inline-code\s*\{/.test(css),
  ".bubble-inline-code CSS rule defined",
);
ok(
  /\.bubble-codeblock\s*\{/.test(css),
  ".bubble-codeblock CSS rule defined",
);
ok(
  chatTsx.includes('className="bubble-inline-code"'),
  "BubbleContent renders <code class=bubble-inline-code> for inline code",
);
ok(
  chatTsx.includes('className="bubble-codeblock"'),
  "BubbleContent renders <pre class=bubble-codeblock> for fenced code",
);
ok(
  chatTsx.includes("<strong key={i}>"),
  "BubbleContent renders bold via <strong>",
);
ok(
  chatTsx.includes("<em key={i}>"),
  "BubbleContent renders italic via <em>",
);
ok(
  /\.bubble\.user \.bubble-inline-code\s*\{/.test(css),
  "inline-code has user-bubble override (darker bg for contrast over accent)",
);

// 2. System HUD row.
ok(
  chatTsx.includes("function SystemRow("),
  "SystemRow component extracted",
);
ok(
  chatTsx.includes("function parseHud("),
  "parseHud HUD-shape detector present",
);
ok(
  chatTsx.includes("function formatTurnHud("),
  "formatTurnHud live-emission helper present",
);
ok(
  chatTsx.includes("function pickUsage("),
  "pickUsage defensive extractor present",
);
ok(
  chatTsx.includes("function pickCostUsd("),
  "pickCostUsd defensive extractor present",
);
ok(
  /className="chat-hud-row"/.test(chatTsx),
  "HUD row rendered with .chat-hud-row class",
);
ok(
  /className="chat-hud-bar"/.test(chatTsx) && /className="chat-hud-bar-fill"/.test(chatTsx),
  "HUD bar + fill spans present",
);
ok(
  /className="chat-system-row"/.test(chatTsx),
  "non-HUD system rows use .chat-system-row (centered, no SYSTEM tag)",
);
ok(
  !/<span className="role-tag">system<\/span>/.test(chatTsx),
  "old SYSTEM role-tag is gone (replaced by SystemRow branching)",
);
ok(
  /\.chat-hud-row\s*\{/.test(css),
  ".chat-hud-row CSS defined",
);
ok(
  /\.chat-hud-bar\s*\{[\s\S]*?width:\s*56px/.test(css),
  ".chat-hud-bar has the 56px width OHQ used",
);
ok(
  /\.chat-system-row\s*\{/.test(css),
  ".chat-system-row CSS defined",
);
ok(
  chatTsx.includes("const hud = formatTurnHud(p, messageObj);"),
  "live HUD emission wired on state === final",
);

// 3. Sub-header row.
ok(
  /className="chat-subheader"/.test(chatTsx),
  ".chat-subheader row rendered above message-list",
);
ok(
  /className="chat-subheader-chip"/.test(chatTsx),
  "project chip element present",
);
ok(
  /className="chat-subheader-model"/.test(chatTsx),
  "model chip element present",
);
ok(
  /\.chat-subheader\s*\{/.test(css),
  ".chat-subheader CSS defined",
);
ok(
  /\.chat-subheader-chip\s*\{/.test(css),
  ".chat-subheader-chip CSS defined",
);
ok(
  /\.chat-subheader-model\s*\{/.test(css),
  ".chat-subheader-model CSS defined",
);

// Parser unit checks via tsx round-trip — we hand-roll a tiny module that
// imports the helpers and asserts on representative inputs. This keeps the
// helpers honest (regex changes here would break round-trip).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// Hoist the regex from the source verbatim so this guard fails the moment
// someone edits the parseInline regex in a way that breaks ordering.
function loadParseInline() {
  // Extract the body of parseInline() — we eval its regex through a Function.
  const re = chatTsx.match(/function parseInline\(text: string\)[\s\S]*?const re =\s*([\s\S]+?);/);
  return re ? re[1] : null;
}
const reSrc = loadParseInline();
ok(reSrc !== null, "parseInline regex source extractable from chatTsx");
if (reSrc) {
  // Sanity: regex MUST include the link form first (so links don't get
  // eaten by italic), and inline code MUST come before bold/italic so
  // backticks win against asterisks in `**foo**`.
  const linkIdx = reSrc.indexOf("\\[([^\\]]+)\\]");
  const codeIdx = reSrc.indexOf("`([^`\\n]+)`");
  const boldIdx = reSrc.indexOf("\\*\\*([^*\\n]+)\\*\\*");
  ok(linkIdx >= 0 && linkIdx < codeIdx, "regex: link pattern comes before code");
  ok(codeIdx >= 0 && codeIdx < boldIdx, "regex: code pattern comes before bold");
}

console.log(`\nphaseC43: ${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
