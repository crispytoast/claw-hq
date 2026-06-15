# 2026-06-15 — OHQ → Claw HQ migration, Day 2

Day 2 of the locked 5-phase OHQ migration: chat history import.

## Goal

Bring Frank's six OHQ chats into Claw HQ so he can resume work there. One-way migration — OHQ stays read-only after this; new conversations happen in Claw HQ.

## Approach

A generic CLI command (`claw-hq import-ohq <source-dir>`), not a one-shot script with Frank's path hardcoded. Per `[[feedback-claw-hq-code-stays-generic]]`, every commit has to work for any user.

Default behaviour is a dry-run that reports what *would* be imported. `--live` actually writes. Existing chats are not overwritten without `--force`.

## Schema mapping (OHQ → Claw HQ)

| OHQ field | Claw HQ field | Note |
| --- | --- | --- |
| `id` (uuid) | `id` | preserved if valid UUID, regenerated otherwise |
| `title` | `title` | trimmed, 200-char cap |
| `project` | `projectSlug` | passed through |
| `createdAt` (ISO) | `createdMs` | parsed |
| `updatedAt` (ISO) | `updatedMs` | parsed |
| `claudeSessionId` | dropped | Claw HQ doesn't model this |
| `model` | dropped | per-chat model lives in `sessions.patch` now |

Message blocks collapse from OHQ's seven kinds into Claw HQ's four roles. Per-message timestamps don't exist in OHQ — we linearly interpolate between `createdAt` and `updatedAt` so the log scrolls back in roughly the right order.

| OHQ block kind | Claw HQ role | Content |
| --- | --- | --- |
| `user` | `user` | text + `[📎 name](/uploads/<sha>)` per attachment |
| `assistant-text` | `assistant` | text |
| `system` | `system` | text + optional `· ctx N.N%` suffix |
| `error` | `system` | `[error] <text>` |
| `ask-question` | `system` | `[question]\n<q>\n• <label>…` (no longer tappable on imported history) |
| `tool-use` + next `tool-result` | `tool` | JSON shape from Phase C step 9: `{toolCallId, name, args:{summary}, result, isError, startedMs, doneMs}` |
| orphan `tool-result` | `system` | `[tool-result · ok/error] <summary>` |

Tool-use pairs collapse one row per call, matching the persisted shape that ChatApp.tsx reconstructs into a `DisplayTool` item on history load.

## Attachments

OHQ stores uploads under `<source>/.oswald-hq/uploads/<chatId>/<filename>`, referenced inside user blocks via `images[]` (URLs) and `files[]` (URL + name). Claw HQ's relay uses content-addressed storage: `<dataDir>/uploads/<sha256>.<ext>` + `<sha256>.meta.json`.

The importer:
1. Walks every `user` block in the source chat, collects unique attachment URLs.
2. SHA-256s the bytes on disk; that hash is the new ID.
3. Copies the blob into `<dataDir>/uploads/<sha>.<ext>` (skips if a blob with that hash already exists — content-addressed dedup is free).
4. Writes a meta sidecar with `{filename, mimeType, size, createdMs}`. MIME is inferred from extension via the same table as the relay's `/api/uploads` route.
5. Rewrites every reference to that URL inside the rendered message text. Plain string-replace is safe — OHQ URLs contain two UUIDs (`/api/chats/<chatId>/attachments/<fileUuid>`), collisions are vanishingly unlikely.

## Files

- `apps/cli/src/import-ohq.ts` — the command.
- `apps/cli/src/index.ts` — wired into the router + usage block.
- `apps/cloud-relay/scripts/phaseM3-import-ohq-test.mjs` — 54-assertion smoke.

## CLI surface

```
claw-hq import-ohq <source-dir> [options]

  --live              Actually write. Default is dry-run.
  --force             Overwrite existing Claw HQ chats with same id.
  --chat <id>         Import only the chat with this UUID.
  --project <slug>    Import only chats with this project slug. "none" for null.
  --skip-attachments  Don't copy uploads.
  -h, --help          Show this message.
```

Target dirs come from:
- chats → `~/.openclaw/clawhq/data/chats/` (plugin-owned, fixed)
- uploads → `<config.dataDir>/uploads/` via `readConfig()` (relay-owned, configurable)

## phaseM3 smoke (54 assertions)

Pure file-system test. Builds a synthetic OHQ source dir in a tmp workspace, runs the CLI against tmp target dirs via `CLAW_HQ_CONFIG` + `HOME` redirection. Covers:

1. dry-run prints summary, writes zero files
2. live mode writes chat JSONs in Claw HQ shape
3. tool-use + tool-result pair collapses into single `tool` entry with correct payload
4. user attachment URLs rewritten to `/uploads/<sha>`
5. attachment meta sidecar written with right mimeType + size
6. content-addressed dedup — same bytes referenced from two chats = one blob on disk
7. existing chat not overwritten without `--force`
8. `--force` overwrites
9. `--chat <id>` filter limits to one
10. `--project <slug>` + `--project none` filters work
11. missing source dir exits non-zero
12. ask-question, error, and system-with-ctxPct shape preserved

Does not touch the live relay, Frank's chats, or his uploads.

## Type-check

CLI passes `tsc --noEmit -p tsconfig.json` clean under the workspace's strict + `noUncheckedIndexedAccess` settings. Two minor guards added (`if (!block) continue` in the message loop; explicit nullability check on the regex match groups for the URL pattern).

## Live import — actually ran

Frank said go. `claw-hq import-ohq /home/jesse/.openclaw/workspace --live`:

| chat | title | project | blocks → msgs | attach |
| --- | --- | --- | --- | --- |
| 01eff93f… | General Chat | (none) | 3 → 3 | 0 |
| 22754cef… | The Youtube Thing | liminal-yt | 323 → 211 | 0 |
| 2d951631… | UI Design + Feature Design | hq | 1042 → 655 | 0 |
| 584f6340… | The Interface - Claw HQ | the-interface-claw-hq | 6356 → 3722 | 11 |
| 9a201d13… | PM HQ | pm-hq | 25416 → 14328 | 46 |
| b2902c2d… | Making Money | making-money | 318 → 205 | 0 |

Done. Wrote 6 chats; 50 new attachment blobs (7 of the 57 referenced were already content-addressed-deduped against earlier copies in the source workspace).

Chats dir went 1 → 7. Sample read of `01eff93f…` parsed cleanly to Claw HQ shape: `projectSlug=None`, `createdMs/updatedMs` parsed from ISO, 3 messages (user / assistant / system), ctx% suffix preserved.

## Known carry-overs

- The 25k-message PM HQ chat is a single 8.4 MB JSON. The sidebar doesn't paginate yet — first open will be slow. Acceptable for now; pagination is a future polish.
- Chat `2d951631` carries `projectSlug=hq` from a long-dead OHQ project. Left as-is (still appears under All Sessions); the slug is a no-op link until Frank deletes the chat or renames the binding.
- Per-message timestamps are interpolated, not real. Acceptable — history is for reading, not analytics.

## Status

HEAD pre-commit: `88bc075`. After this commit: Day 2 lands as one commit on `master`, NOT pushed (per rule). Frank's authorization stays scoped to this turn; push waits for an explicit ask.

Next on "proceed": Day 3-5 — UI gap fill against OHQ (iterative, Frank-driven via screenshots + a systematic side-by-side).
