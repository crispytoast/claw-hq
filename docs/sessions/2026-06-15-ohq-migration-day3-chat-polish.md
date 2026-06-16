# 2026-06-15 — OHQ migration Day 3 (chat-tier polish)

Continuation of OHQ migration. Days 1–3 (auth + funnel + import CLI + UI gap-fill
batch) shipped earlier today. Frank's "proceed" → first cut of the chat-tier
polish wedge from the migration plan: typing indicator, bubble animation,
streaming caret.

## What shipped — Phase C step 42

One commit, SPA-only, no plugin / no APK / no relay restart needed for code,
but the service was restarted to serve the new bundle.

- **`apps/web/src/components/ChatDetailView.tsx`** — three changes:
  1. Computes `showThinking` from `pending` + `items` tail. Visible only when a
     send is in-flight AND nothing has responded yet (last item is still the
     user's message).
  2. Renders a new `.thinking-indicator` row (three `<span>` dots) between the
     items map and the error/drag overlay rows.
  3. Replaces the post-bubble `<span className="spinner" .../>` with
     `<span className="streaming-caret" aria-hidden="true" />` — a blinking
     vertical bar inline at the end of streaming assistant text. The spinner
     looked like "loading the page"; the caret reads as "actively typing."
- **`apps/web/src/styles.css`** — adds (in order):
  - `@keyframes chat-item-in` + the four-class fade-in rule (`.bubble`,
    `.tool-block`, `.approval-block`, `.question-block`) so EVERY new chat
    item slides up + fades in over 180 ms. The React key on each list item
    means re-renders don't re-trigger — only mount does.
  - `.streaming-caret` (7×1em accent-color bar, `steps(2, start)` 900 ms blink
    via a `visibility: hidden` keyframe — sharper than opacity-fade for a
    caret).
  - `.thinking-indicator` flex row with three accent-color dots, each
    bouncing on a staggered `thinking-dot` keyframe (delays 0 / 160 ms /
    320 ms — that 160 ms gap was tuned by ear; it feels like a heartbeat
    rather than a wave).
  - `@media (prefers-reduced-motion: reduce)` block disables all three new
    animations. Caret stays visible (no animation, baseline opacity); dots
    stay visible (no bounce, baseline opacity 0.8); fade-ins go straight
    to final state.

## Why this shape (the design calls)

- **OHQ uses one pulsing dot + "thinking…" text.** Three bouncing dots is
  the more universal chat affordance and reads from across the room. Pushing
  past OHQ here, not just matching it.
- **No avatars / no role chips.** Considered adding them on the left side of
  each bubble (You / HQ initials). Skipped — Claw HQ's assistant text is
  already unboxed (transparent background, full-width) and the user bubble
  is solid cyan. The visual contrast already encodes role. An avatar column
  would steal horizontal space on mobile where Frank lives.
- **Caret > spinner.** A spinner reads as "the system is loading" — generic
  busy state. A caret reads as "the agent is typing right now" — same
  semantic the user gets from any chat UI in the last decade. Same `streaming`
  signal, sharper read.
- **Fade-in over slide-in.** Considered a `translateY(8px)` slide. Toned it
  down to `4px` because Frank's chats can have many tool blocks landing in
  quick succession during a turn; a big slide would feel jittery. The 180 ms
  duration is fast enough to feel responsive, slow enough to register.
- **Reduced-motion guard is non-optional.** Three independent animations
  layered on every bubble + every tool call would be hostile to users with
  vestibular sensitivity. The guard disables every keyframe; nothing else
  in `styles.css` was already guarded so this is also the first such media
  query in the file.

## Why these conditions (the gate logic)

`showThinking` short-circuits unless:
1. `pending === true` (a `chat.send` is in flight), AND
2. the last `items` element is a user message.

Once anything else lands after the user message — a streaming assistant
bubble, a tool block, an approval card, an AskUserQuestion card — the agent
is visibly responding and the dots would be redundant. The check is on the
LAST element, not "any element after the last user index," because tool
calls + assistant text get appended in arrival order; once the first one
lands, the user message is no longer the tail.

`setPending(false)` fires in three places: on `state === "final"` (assistant
stream done, line 670), on send-error (line 1125), and on AskUserQuestion
answer-flow error (line 1180). All three close the indicator correctly.

## Smoke

`apps/cloud-relay/scripts/phaseC42-chat-polish-test.mjs` — 22 assertions:
- 6 JSX hooks (showThinking computation present, .thinking-indicator
  rendered with aria-label + 3 dots, .streaming-caret rendered, old inline
  spinner gone, showThinking gate uses the right tail check)
- 13 CSS rules (keyframes defined, animation applied to all four classes,
  stagger delays, reduced-motion guard disables all three animations)
- 3 gate-logic regex checks on the showThinking IIFE

Runs without a live relay. Pattern: same source-aware smoke style as
`phaseC38b-class-name-consistency-test.mjs` — catches typos and silent CSS
drift the moment they're committed.

## Build / deploy

- `pnpm build` clean (initial run failed on TS strict `noUncheckedIndexedAccess`
  for the indexed `items[i]` access in the showThinking gate — rewrote to
  use `items[items.length - 1]` with explicit `undefined` narrowing).
- New bundle: `dist/assets/index-Dj4l62IS.js` (337 kB / 96 kB gzip),
  `dist/assets/index-BB_cg9sV.css` (54 kB / 9.6 kB gzip).
- `systemctl --user restart claw-hq.service` — active. Frank can hard-refresh
  his browser / reopen the APK to pick up the new bundle. No APK rebuild
  needed — pure SPA change.

## Known gaps / next polish wedges

- Per-message timestamps on hover (OHQ doesn't have them either; could be a
  small win if Frank wants to refer back to "what did I say five minutes
  ago").
- Group consecutive assistant messages from the same turn under one visual
  "card" (right now each delta-final flush makes its own bubble; if the
  agent makes two distinct text emissions in one turn they look like two
  separate replies).
- Dual-run validation: this is the first session of "use Claw HQ as primary,
  OHQ as fallback." Frank will surface specific things off as he uses it.

## Status anchors after this commit

- HEAD: this commit (TBD until git commit returns), 1 ahead of origin (NOT
  pushed per rule).
- APK: 0.4.7 (unchanged).
- Plugin: v0.0.16 LIVE (unchanged).
- Smoke suite: 38 scripts on disk now (37 + phaseC42).
