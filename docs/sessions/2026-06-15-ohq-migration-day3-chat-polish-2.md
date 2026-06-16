# 2026-06-15 — OHQ migration Day 3 (chat-tier polish round 2)

Frank pulled up two phone screenshots side-by-side — Claw HQ vs OHQ on the
same workspace — and asked "see the difference?" Three concrete gaps:

1. Inline backticks rendering as literal text instead of styled code chips.
2. The per-turn HUD strip (`done · tok · $cost · ctx N%`) was appearing as a
   plain centered "SYSTEM" row floating mid-flow in imported history, with
   no styling, no progress bar, and nothing emitted live for new turns.
3. No sub-header row under the title — Claw HQ's top bar was just the title
   + bell + online pill, no project chip, no model selector. Hard to tell
   what context you're in when you scroll up.

He said "do them all" — this is Phase C step 43, one commit, SPA-only.

## What shipped

### 1. Inline markdown rendering (the broken one)

`BubbleContent` was only parsing `[label](url)` links. Bold, italic, and
inline code all fell through with literal markers visible. Replaced the
single-pattern regex with a two-stage parser:

- `parseBlocks` first splits on fenced code blocks (```` ```lang\n…\n``` ````
  matched non-greedy with `[\s\S]*?`). Anything inside renders as
  `<pre class="bubble-codeblock"><code>…</code></pre>` — overflow-x: auto,
  monospace font, subtle bg.
- `parseInline` runs over each non-code segment with a single regex that
  alternates link / inline-code / bold(`**`) / bold(`__`) / italic(`*`) /
  italic(`_`). Order is load-bearing — link first so URLs containing
  asterisks don't get half-eaten by italic, code before bold so backticks
  win against `**` inside `**\`foo\`**`. The smoke test enforces the order
  via a regex on the source.
- Renders as `<a class="bubble-link">`, `<code class="bubble-inline-code">`,
  `<strong>`, `<em>`. Highlight-on-search still works inside each segment
  via `highlightText`.

CSS for the chip look:
- `.bubble-inline-code` — tight border, monospace, `font-size: 0.88em` so it
  sits with the surrounding text without growing the line. `word-break:
  break-word` so long identifiers wrap inside the bubble.
- `.bubble.user .bubble-inline-code` override — over the solid cyan user
  bubble, the default rgba bg is invisible; switched to a darker rgba(0,
  0, 0, 0.25) + lighter border for contrast.
- `.bubble-codeblock` — full block of monospace text with a card border.

### 2. HUD row repositioned + restyled + emitted live

Two pieces. **Style:** factored system bubbles into a new `SystemRow`
component. `parseHud(text)` detects the OHQ-shape (`/^(?:[—-]\s*)?(done|
error|stopped)\b/i` + ` · ctx N%` tail) and returns `{body, ctxPct}`. If it
matches, render `.chat-hud-row` with the 56×4 px progress bar (green
under 70%, accent up to 90%, maroon above — same threshold OHQ uses at
`ChatView.tsx:1304`). If it doesn't match, render `.chat-system-row` —
centered + muted but no bar. The "SYSTEM" role-tag is gone from both
paths; the centered/monospace styling reads as "out-of-band note" without
needing a label.

**Emit:** added `formatTurnHud(p, messageObj)` called from the
`state === "final"` branch of the chat event listener. Reads usage + cost
defensively from multiple key shapes (`p.usage`, `p.finalUsage`,
`messageObj.usage`, `p.result.usage` — snake_case + camelCase). If usage
is present, builds `done · N→N tok · $X.XXXX` and computes
`ctxPct = (input + cache_read + cache_creation) / 200_000 * 100`. Appends
as a transient system row in `items` (not persisted — HUD is per-turn
state, not chat content). Degrades to no-emit if the gateway doesn't
expose these fields yet; in that case the imported OHQ history still
renders correctly via `parseHud` on the persisted text.

The `CONTEXT_LIMIT = 200_000` matches Anthropic's 1M-token Sonnet 4.6
window divided by typical effective context (~200k useful tokens before
the prompt cache starts evicting). If/when we surface a per-model context
limit from the gateway, this becomes a passed-in value.

### 3. Sub-header row above the message list

New `.chat-subheader` flex row inserted inside `ChatDetailView`'s return,
above `.message-list`:
- Left: chat title (the same string the page-toolbar already shows
  upstream, but the toolbar truncates and isn't always visible after
  scroll).
- Middle: project chip when `projectSlug` is set — accent-bordered pill
  with the slug in monospace. Pure information, not yet a link target
  (could become a project-page jump in a follow-up).
- Right: model chip showing `Default ⌄` — read-only for v1, tooltip
  surfaces "Per-chat model override coming soon — set defaults from
  Models page." Per-chat override is its own wedge (step 30 already
  added per-session override on the Models page; threading it down to
  the chat is the next iteration).

Border-bottom seam against `--sidebar-border` so the row doesn't blend
into the messages.

## Smoke

`apps/cloud-relay/scripts/phaseC43-chat-polish-2-test.mjs` — 31 assertions
across three groups (inline-markdown JSX + CSS, system HUD JSX + CSS +
extractors + live emission wiring, sub-header JSX + CSS) plus parser
ordering guards on the parseInline regex. The order guards (link < code <
bold) are the load-bearing ones — if someone reorders or shortens the
alternation later, the smoke fails immediately because the wrong precedence
breaks links with asterisks AND prevents code inside bold from rendering.

No live-relay calls — pure source-aware checks. Runs against the source
tree, would fail in CI if the file shape drifted.

## Build / deploy

- `pnpm build` clean.
- New bundle: `dist/assets/index-DTnJOmXa.js` (340.94 kB / 97.78 kB gzip,
  up 3.86 kB from step 42's 337.08 kB — the parser + HUD helpers + SystemRow
  + sub-header JSX). CSS bundle 56.65 kB / 10.02 kB gzip, up 2.4 kB for
  the new rules + media-query reorganization.
- `systemctl --user restart claw-hq.service` — active. Browser hard-refresh
  to pick up the new bundle. APK 0.4.7 unchanged (SPA-only).

## Known gaps / next polish

- Sub-header model chip is read-only. Threading the per-session model
  override (step 30 Models page) into the chat picker is the obvious
  next step.
- HUD live-emission depends on OpenClaw's gateway forwarding usage + cost
  on the chat event. If it doesn't (we read defensively and degrade), we
  won't see live HUD rows on new turns until the plugin grows that
  forwarding. Imported OHQ history still renders correctly because the
  HUD text was persisted as message content and `parseHud` matches it.
- Code-block syntax highlighting — current `.bubble-codeblock` is plain
  monospace. Could add a lightweight highlighter (shiki, prism) but
  that's a 100 kB bundle hit; skipped for now.

## Status anchors after this commit

- HEAD: this commit (TBD), 2 ahead of origin (step 42 also unpushed).
- APK: 0.4.7 (unchanged).
- Plugin: v0.0.16 LIVE (unchanged).
- Smoke suite: 39 scripts on disk (38 + phaseC43).
