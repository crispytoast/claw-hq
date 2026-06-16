#!/usr/bin/env node
/**
 * Phase C step 45 — adopt OHQ's visual tier (font, foreground, line rhythm,
 * soft borders, markdown block rendering).
 *
 * Source-aware smoke. Verifies Inter is loaded, root tokens shifted to OHQ's
 * warm palette, bubble line-height + markdown rhythm rules present, BubbleContent
 * renders headings / hr / blockquote / lists. Brand accent (cyan) MUST stay
 * locked per project memory — assertion at the bottom guards that.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const index = readFileSync(resolve(REPO, "apps/web/index.html"), "utf-8");
const css = readFileSync(resolve(REPO, "apps/web/src/styles.css"), "utf-8");
const chatTsx = readFileSync(
  resolve(REPO, "apps/web/src/components/ChatDetailView.tsx"),
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

console.log("Phase C step 45 — OHQ visual tier source checks");

// Inter + JetBrains Mono fonts loaded via Google CDN.
ok(
  /fonts\.googleapis\.com\/css2\?family=Inter:/.test(index),
  "Inter web font linked in index.html",
);
ok(
  /family=JetBrains\+Mono/.test(index),
  "JetBrains Mono linked in index.html",
);
ok(
  /preconnect.*fonts\.googleapis\.com/.test(index),
  "fonts preconnect present for snappier first paint",
);

// Root tokens — fonts + warm foreground + softer borders.
ok(
  /--font-sans:\s*"Inter"/.test(css),
  "--font-sans token uses Inter",
);
ok(
  /--font-mono:\s*"JetBrains Mono"/.test(css),
  "--font-mono token uses JetBrains Mono",
);
ok(
  /--foreground:\s*#e8e6dd/.test(css),
  "--foreground shifted to warm off-white #e8e6dd matching OHQ",
);
ok(
  /--text:\s*#e8e6dd/.test(css),
  "--text shifted to warm off-white #e8e6dd",
);
ok(
  /--muted-foreground:\s*#9a9a92/.test(css),
  "--muted-foreground softened to warm grey #9a9a92",
);
ok(
  /--border:\s*#2a2a2a/.test(css),
  "--border softened toward bg (#2a2a2a) — closer to surface",
);
ok(
  /--sidebar-border:\s*#2a2a2a/.test(css),
  "--sidebar-border softened to #2a2a2a",
);

// Body styles — Inter, generous line-height, font-feature-settings.
ok(
  /font-family:\s*var\(--font-sans\)/.test(css),
  "body uses --font-sans variable",
);
ok(
  /line-height:\s*1\.55/.test(css),
  "body line-height bumped to 1.55",
);
ok(
  /font-feature-settings:.*"cv02"/.test(css),
  "Inter character variants enabled for sharper rendering",
);
ok(
  /-moz-osx-font-smoothing:\s*grayscale/.test(css),
  "Firefox font smoothing enabled",
);

// Themed scrollbars.
ok(
  /scrollbar-width:\s*thin/.test(css),
  "scrollbars sized thin",
);
ok(
  /::-webkit-scrollbar \{\s*width:\s*8px/.test(css),
  "webkit scrollbar thumb sized 8px",
);

// Bubble rhythm.
ok(
  /\.bubble \{[\s\S]*?line-height:\s*1\.7/.test(css),
  ".bubble line-height bumped to 1.7 for OHQ-style reading rhythm",
);
ok(
  /\.bubble h1 \{/.test(css) && /\.bubble h2 \{/.test(css) && /\.bubble h3 \{/.test(css),
  ".bubble heading CSS rules (h1/h2/h3) defined",
);
ok(
  /\.bubble ul,\s*\.bubble ol/.test(css),
  ".bubble list CSS rules defined",
);
ok(
  /\.bubble blockquote \{[\s\S]*?border-left:\s*2px solid var\(--accent\)/.test(css),
  ".bubble blockquote uses 2px accent left border (matches OHQ)",
);
ok(
  /\.bubble hr \{/.test(css),
  ".bubble hr CSS defined",
);

// BubbleContent renders block markdown.
ok(
  chatTsx.includes('| { kind: "heading"; level: 1 | 2 | 3'),
  "BlockPart union extended with heading",
);
ok(
  chatTsx.includes('| { kind: "hr" }'),
  "BlockPart union extended with hr",
);
ok(
  chatTsx.includes('| { kind: "blockquote";'),
  "BlockPart union extended with blockquote",
);
ok(
  chatTsx.includes('| { kind: "ul"; items:'),
  "BlockPart union extended with ul",
);
ok(
  chatTsx.includes('| { kind: "ol"; items:'),
  "BlockPart union extended with ol",
);
ok(
  chatTsx.includes('function classifyParagraph('),
  "classifyParagraph dispatcher present",
);
ok(
  /paragraphs = segment\.split\(\/\\n\{2,\}\/\)/.test(chatTsx),
  "parseBlocks splits non-fence segments on blank lines",
);
ok(
  /return <h1 key=\{bi\}>/.test(chatTsx),
  "BubbleContent renders <h1>",
);
ok(
  /return <h2 key=\{bi\}>/.test(chatTsx),
  "BubbleContent renders <h2>",
);
ok(
  /return <h3 key=\{bi\}>/.test(chatTsx),
  "BubbleContent renders <h3>",
);
ok(
  /return <hr key=\{bi\} \/>/.test(chatTsx),
  "BubbleContent renders <hr/>",
);
ok(
  chatTsx.includes("<blockquote key={bi}>"),
  "BubbleContent renders <blockquote>",
);
ok(
  /const Tag = b\.kind === "ul" \? "ul" : "ol";/.test(chatTsx),
  "BubbleContent renders <ul>/<ol> via dynamic Tag",
);

// CRITICAL — brand accent must stay cyan, NOT swap to OHQ's amber. Project
// memory locks cyan + magenta + maroon (#B83C5C). If anyone shifts the
// accent token to amber #d4a24c this assertion fails loudly.
ok(
  /--accent:\s*#00d9d9/.test(css),
  "--accent stays CYAN (#00d9d9) — brand identity locked, NOT OHQ amber",
);
ok(
  /--accent-rgb:\s*0,\s*217,\s*217/.test(css),
  "--accent-rgb stays cyan triple",
);

console.log(`\nphaseC45: ${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
