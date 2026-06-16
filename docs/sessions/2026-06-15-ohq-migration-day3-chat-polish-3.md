# 2026-06-15 — OHQ migration Day 3 (chat-tier polish round 3)

Frank's directive after step 43: "Make the chat box match the one in OHQ. Make
the + button functional and make the Claude button in the chat box do what the
Default dropdown menu does, then remove the Default button from the top right
of the page."

The `Default` chip I added in step 43's sub-header was supposed to be a model
selector but I shipped it as a read-only tooltip-only placeholder. Frank wants
the model selector inside the composer (OHQ pattern) and the sub-header chip
gone.

This is Phase C step 44, SPA-only, one commit.

## What shipped

### Composer reshaped to OHQ two-row pill

**Before:** `[🎤] [+ attach] [📋 history] <textarea> [↑ send]` all in one
horizontal `.composer .row`. Buttons cramped on the left of the input on
mobile.

**After:** vertical column inside the same rounded pill —
- Row 1: `<textarea>` full width
- Row 2: `[+ attach]` `[🎤 mic]` `[📋 history]` `[Model ⌄]` ... `[↑ send]`

CSS swap on `.composer .row` from `flex-direction: row` to `column`. Buttons
get their own row at proper tap-targets; matches OHQ at
`oswald-hq/src/app/chat/[id]/ChatView.tsx:851-908`.

The `+` button was already wired to the file picker — what Frank meant was
"make it visually functional" in the OHQ style. It now sits as the leftmost
chip in the action row.

### Model selector now lives in the composer

New `.composer-model-chip` button + `.composer-model-menu` popover. Driven
by the same OpenClaw RPCs the Models page already uses (step 30):

- On mount, `sessions.list` finds our session row and reads its
  `resolvedModel` (or `model` fallback) into `currentModel`. Soft-fails so
  gateway builds that don't surface the field just leave the chip showing
  "Default".
- On first chip click, `models.list` populates the menu (cached for the
  session). Subsequent clicks toggle without re-fetching.
- Picking a model fires `sessions.patch({key: sessionKey, model: id})`;
  patch result's `resolvedModel` / `model` updates the chip label.
  `pickModel(null)` resets to gateway default.
- `modelLabel` strips the provider prefix and hyphens —
  `anthropic:claude-sonnet-4-6` renders as `sonnet 4.6` on the chip. Full
  ID is in the tooltip.

The popover anchors above the chip (`bottom: calc(100% + 0.4rem)`),
opens with a 140 ms fade-in matching the rest of the chat tier, closes on
`onMouseLeave` for desktop and on selection for both. Error path renders
the failure inline at the top of the menu; loading state shows a spinner.

### Sub-header `Default` chip removed

JSX block deleted. CSS rules `.chat-subheader-model` and
`.chat-subheader-model-caret` removed (smoke enforces both are gone). The
chat title and project chip remain — those are still useful orientation
when scrolled.

## Smoke

`apps/cloud-relay/scripts/phaseC44-composer-model-test.mjs` — 25 assertions:
- Sub-header model chip + CSS gone (3)
- State hooks declared (4)
- Right RPCs called (sessions.list / models.list / sessions.patch) (3)
- `resolvedModel` preferred over `model` (1)
- Composer JSX shape — textarea appears before composer-actions block (1)
- Action buttons + popover semantics (5)
- CSS rules for column layout + chip + menu + active row (6)
- `+ attach` still wired to file picker (1)
- `Default` row resets to null (1)

Source-aware; no live relay.

## Build / deploy

- `pnpm build` clean.
- Bundle: `dist/assets/index-CrORveEi.js` (343.29 kB / 98.31 kB gzip,
  +2.35 kB on step 43's bundle for the model-menu logic). CSS bundle
  58.42 kB / 10.31 kB gzip, +1.77 kB.
- `systemctl --user restart claw-hq.service` — active. Browser hard-refresh
  picks up the new bundle. APK 0.4.7 unchanged.

## Known gaps / next polish

- Popover dismissal on outside click / Escape — currently dismisses only on
  selection or `onMouseLeave`. Outside-click handler is a small follow-up.
- Per-chat persistence: currently the model override is stored on the
  OpenClaw session, not the Claw HQ chat record. If the session is
  recycled or expires, the override is lost. Persisting it on
  `clawhq.chats.patch` and re-applying on chat open is a future wedge.
- Provider grouping in the menu (Anthropic vs. OpenRouter etc.) —
  ModelsPage groups by provider; the composer menu is flat. Easy upgrade
  once the menu grows past ~6 entries.

## Status anchors after this commit

- HEAD: this commit (TBD), 3 ahead of origin (steps 42 + 43 + 44 unpushed).
- APK: 0.4.7 (unchanged).
- Plugin: v0.0.16 LIVE (unchanged).
- Smoke suite: 40 scripts on disk (39 + phaseC44).
