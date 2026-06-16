# 2026-06-15 — OHQ migration Day 3 (visual tier port)

Frank's directive after step 44: "Look at the pictures I've sent you of OHQ.
Look at the font, the lines, the layout, the whole look and feel. It's visually
appetizing. That is what I want Claw HQ to look like."

I started by asking him to pick a recolor scope (typography-only vs. surfaces
vs. full amber swap) — he declined the menu. Per the user-role memory ("Frank
prefers recommendations over option menus") that was my mistake; I should
have just made the call. Pushing forward with the right tradeoff.

This is Phase C step 45, SPA-only, one commit. The judgment call: adopt
EVERYTHING OHQ does for typography + spacing + lines + reading rhythm, but
KEEP the cyan brand accent locked. The project memory
[[project_pm_hq_ui_overhaul]] explicitly locks cyan + magenta + maroon as the
brand palette; swapping to OHQ's amber would erase Claw HQ's identity. The
smoke includes two assertions that fail loudly if anyone shifts `--accent`
toward amber later.

## What shipped

### Typography port (Inter + JetBrains Mono)

- `apps/web/index.html` gets Google Fonts preconnect + a single CSS link
  pulling Inter (400/500/600/700) and JetBrains Mono (400/500). `display=swap`
  so first paint isn't blocked by the font request.
- New `--font-sans` / `--font-mono` tokens in `:root`. Body font-family
  switches from the OS system stack to `var(--font-sans)`.
- `font-feature-settings: "cv02", "cv03", "cv04", "cv11"` enables Inter's
  character variants (sharper `l`, more open `g`, etc) — the same ones
  OHQ uses.
- `letter-spacing: -0.005em` on body and on `.bubble` — micro-tightening
  that makes the screen feel less spread out without being visible.
- `-moz-osx-font-smoothing: grayscale` so Firefox renders the same weight
  as WebKit/Blink.

### Foreground palette warm-shift

- `--foreground` / `--text`: `#eee` → `#e8e6dd` (warm off-white, OHQ's
  exact value). Pure white over dark surfaces had a sterile feel; the
  warm shift makes the page look read-able for hours.
- `--muted-foreground` / `--text-dim`: `#888` / `#999` → `#9a9a92` (warm
  grey). Same hue family as foreground so muted text sits in the same
  conversation.
- `--sidebar-foreground`: `#d4d4d4` → `#d8d6cd` to match.
- `--text-low`: shifted to `#6e6e66`.

### Softer lines

- `--border` / `--sidebar-border`: `#333` → `#2a2a2a`. The old value was
  too stark against `#1B1B1B` — every component looked outlined. Now
  borders sit ~10% above the surface tone so cards read as layers rather
  than boxes.
- `--bg-elev`: `#262626` → `#232323` to tighten the surface hierarchy.

### Generous line rhythm in chat

- Body line-height: `1.4` → `1.55`. Matches the OHQ globals.
- `.bubble` line-height: `1.5` → `1.7`. Per-bubble vertical breathing
  room. Matches OHQ's `.markdown-content` 1.75; we go slightly tighter
  because Claw HQ has more UI chrome to fit on screen.
- `.bubble` padding: `0.6rem 0.95rem` → `0.65rem 1rem` (one notch more
  generous).

### Markdown block rendering in bubbles

The big behavior change. Step 43's `BubbleContent` only handled inline
markdown (links, code, bold, italic). Now it renders block-level
markdown too:

- `parseBlocks` first carves out fenced ```code``` blocks (unchanged),
  then splits each non-fence segment on `\n{2,}` (blank lines) into
  paragraphs and classifies each via `classifyParagraph`:
  - `# heading` / `## heading` / `### heading` → heading block (level
    1/2/3).
  - `---` / `***` / `___` (3+ on a line) → hr block.
  - Every non-empty line starts with `> ` → blockquote.
  - Every line starts with `- ` or `* ` → ul.
  - Every line starts with `N. ` or `N) ` → ol.
  - Else → inline paragraph (existing path).
- Renderer emits real `<h1>` / `<h2>` / `<h3>` / `<hr>` / `<blockquote>`
  / `<ul>` / `<ol>` / `<li>` tags. CSS in `.bubble {h1..hr}` provides
  the OHQ-style vertical rhythm (h1 `1.45rem` + `mt 1.1rem mb 0.55rem`,
  blockquote with 2 px accent left border, hr as a 1 px sidebar-border
  rule).
- `renderInlinePart` was extracted so each block type can reuse it
  for the inline content within (heading text, blockquote prose, list
  items).

### Themed scrollbars

`scrollbar-width: thin; scrollbar-color: var(--sidebar-border)
transparent;` globally + matching `::-webkit-scrollbar` (8 px) +
`::-webkit-scrollbar-thumb` (rounded sidebar-border bg). Same pattern
as OHQ.

## Smoke

`apps/cloud-relay/scripts/phaseC45-ohq-visual-tier-test.mjs` — 36
assertions:
- Fonts preconnect + linked (3)
- Token shifts in root (7) — fonts, warm fg, softer borders
- Body styles (4) — font-family, line-height, font-feature-settings,
  Firefox smoothing
- Themed scrollbars (2)
- Bubble line-height + markdown CSS (5) — h1/h2/h3, lists, blockquote,
  hr
- BlockPart union + classifier (7)
- Renderer outputs each block tag (6)
- **Brand accent guards (2) — cyan #00d9d9 + the rgb triple. These
  fail loudly if anyone shifts to amber later.**

## Build / deploy

- `pnpm build` clean.
- Bundle: `dist/assets/index-D6eNAlhi.js` (344.44 kB / 98.72 kB gzip,
  +1.15 kB on step 44 for the markdown block classifier + renderer).
  CSS bundle 59.86 kB / 10.68 kB gzip, +1.44 kB for tokens + bubble
  rhythm + scrollbar theming.
- `systemctl --user restart claw-hq.service` — active.

## What Frank will see

- Page text in Inter, slightly warm. The interface feels less harsh.
- Chat bubbles with proper headings (model's `## Section` now renders as
  a real heading, not just bold text), bulleted lists indent and bullet,
  numbered lists number, code blocks card up properly, `---` becomes a
  visual rule, `> quote` gets an accent-bar quoted style.
- Borders that don't pop — cards layer instead of outline.
- Scrollbars that don't intrude.

## Known gaps / next polish

- Sidebar typography hasn't been audited. The sub-component CSS still
  uses inherited values, so it picks up Inter + warm fg automatically,
  but pixel-precise sizes haven't been re-tuned.
- The locked `--bg` (`#1B1B1B`) is the same charcoal as before. OHQ's
  `#0a0f0c` has a teal hint. Keeping `#1B1B1B` per
  [[project_pm_hq_ui_overhaul]] lock. If Frank wants to revisit, that's
  its own decision.
- Image-based rendering across bubbles (model emits PNG art) is still
  link-only; no upgrade in this step.

## Status anchors after this commit

- HEAD: this commit (TBD), 4 ahead of origin (42 + 43 + 44 + 45 unpushed).
- APK: 0.4.7 (unchanged).
- Plugin: v0.0.16 LIVE.
- Smoke suite: 41 scripts on disk.
