# 2026-06-15 — OHQ → Claw HQ migration, Day 3 (UI gap-fill batch)

Day 3 of the locked 5-phase OHQ migration: systematic page-tier gap-fill against OHQ. Frank's "do them all" landed four wedges in one batch: Phase C steps 38 → 41.

## What landed

| step | commit | summary |
| --- | --- | --- |
| 38 | `f2fde1c` | workspace `/docs` search page |
| 39 | `fafff2c` | workspace `/memory` daily browser |
| 40 | `10af54a` | global `/tasks` rollup |
| 41 | `10be743` | home dashboard |

Plugin bumped 0.0.13 → 0.0.16 across the batch (one minor per plugin-touching step). Tarball at `apps/openclaw-plugin/claw-hq-openclaw-plugin-0.0.16.tgz`. SPA rebuilt; dist is current. No APK changes (matches the "WebView wrapper — SPA changes go live on app reopen" rule from Phase C step 34).

## Why this batch shape

The migration plan's Day 3-5 section reads "Frank screenshots a specific OHQ screen, names what's off, I match it. Iterative. I also do a systematic side-by-side pass." The systematic pass surfaced four OHQ pages Claw HQ had no equivalent for:

- **`/docs`** — workspace-wide markdown browser
- **`/memory`** — daily-rollup view of `<workspace>/memory/YYYY-MM-DD.md`
- **`/tasks`** — aggregated GFM checkboxes across all sub-projects
- **`/`** (home) — stats tiles for quick orientation

Frank said "do them all" so the batch landed in one session, each as its own commit with its own smoke. Skipped from the inventory because cosmetic (`/calendar`) or OHQ-specific narrative pages (`/team`, `/visual-office`).

## Step 38 — `/docs` workspace search

Plugin v0.0.14. New `apps/openclaw-plugin/src/docs.ts` walks `<workspaceRoot>/**/*.md` with the same `SKIP_DIRS` set the rest of the plugin uses (secrets/.git/.openclaw/.oswald-hq/dist/build/.next/node_modules). Belt-and-suspenders: each result is also re-checked path-by-path so a `getDoc` call with an explicit traversal-y path is rejected even if the disk happens to allow it.

Three methods registered on the gateway:
- `clawhq.docs.list` → `{docs: DocSummary[], workspaceRoot}`
- `clawhq.docs.get({relativePath})` → `{doc: DocContent}` with 1 MB soft cap (returns head + truncation notice for absurdly large files)
- `clawhq.docs.search({query})` → `{hits: DocSearchHit[], totalDocsScanned, query}` — case-insensitive substring search across content + path, ranked by match count, capped at 200 hits with max 2 snippets per hit (80-char window each, line number tagged)

SPA: `pages/DocsPage.tsx` — split-pane with tree on the left, viewer on the right. Tree auto-expands top-level dirs on first load; ancestors auto-expand when a search hit is opened (so the file shows in context). Debounced search field flips the left rail from tree → hits list. Markdown rendered as `<pre>` for now — matches the existing ProjectPage convention; proper rendering is a separate wedge.

phaseC38 smoke: 15 assertions (source-wired) covering Sidebar registration, ChatApp page-key routing, RPC names, plugin method registration, `SKIP_DIRS` guard, traversal guard.

## Step 39 — `/memory` workspace daily browser

Plugin v0.0.15. Extended `memory.ts` with `getLongTermMemory({workspaceRoot})` that reads `<workspaceRoot>/MEMORY.md` (workspace root, **not** under `memory/`). Traversal guard scoped to the workspace root.

One new method: `clawhq.memory.longTerm` returning `{exists: false}` (not error) when the file is absent so the SPA can render a friendly empty-state.

SPA: `pages/WorkspaceMemoryPage.tsx` — distinct from the existing `MemoryEditorPage` which is per-file CRUD. Sidebar layout:
- "Long-term" section with pinned `MEMORY.md` row at the top
- "Daily entries" grouped by month (`YYYY-MM` headers), filtered to the `YYYY-MM-DD.md` filename pattern, sorted newest-first by date
- "Other files" bucket for non-dated entries
- Filter input narrows daily entries by date string match

Reuses existing `clawhq.memory.{list,get}` so no new read paths. Active selection uses a sentinel `__long_term__` key that the content-pane effect translates into the cached long-term payload.

phaseC39 smoke: 17 assertions covering memory.ts helper + traversal guard, plugin registration, Sidebar + ChatApp wiring, page RPC names, date-grouping behaviour, long-term sentinel.

## Step 40 — global `/tasks` rollup

Plugin v0.0.16. Extended `tasks.ts` with `listAllTasks({workspaceRoot})` that walks every `<workspaceRoot>/projects/<slug>/TASKS.md` and every `<slug>/subprojects/<sub>/TASKS.md`, parses GFM checkboxes via the existing regex, resolves project + sub names via a new `nameFromBrief` helper.

`nameFromBrief` matches OHQ's `listSubprojects` convention: **frontmatter `name:` wins over the H1**. The first test cut had H1 winning and tripped the smoke — fixed before commit (frontmatter is canonical for subprojects per workspace conventions; H1 is just a header).

One new method: `clawhq.tasks.listAll` returning `{tasks, projectsScanned, filesRead}`. Each row carries the per-file `lineIndex` (not a global index), so toggle round-trips to the **same** `clawhq.tasks.toggle` endpoint the existing in-doc checkboxes use — no new write path.

SPA: `pages/TasksPage.tsx` — three-tab filter (Open / Done / All) + free-text filter, grouped by project then by file (project root first, then sub-projects alphabetically). Toggle is optimistic: invert local state immediately, fire RPC, revert on error.

phaseC40 smoke: 30 assertions — source-wired plus a real-fs round-trip test. Synthetic workspace with project-root, sub-project, frontmatter-using-sub, and a `secrets/` project to verify rollup behaviour end-to-end without a live gateway.

## Step 41 — home dashboard

SPA-only — composes existing RPCs into one orientation surface. Six tiles (Projects / Subprojects / Open tasks / Docs / Memory / Chats) fed by parallel probes against the existing endpoints + the new step-38/40 additions. Each tile clicks through to its corresponding page via the `onSelectPage` handler already in `ChatApp.handleSelectPage`.

Each probe slice tracks its own loading + error so one slow probe doesn't black out the whole grid — failed tiles show `—` plus the error string instead of a value.

Recent-activity rail below the tiles merges newest chats + workspace memory files + recently-modified docs, sorts by mtime, shows the top 8. Best-effort secondary read; failures get suppressed.

**Does not change the default landing.** Chat is still where the app opens. Home is opt-in via sidebar tap or `/home` deep link.

phaseC41 smoke: 19 assertions covering Sidebar + page-key, ChatApp router + `onSelectPage` handoff, deep link, every probe RPC name, per-tile navigation targets, recent-activity sort order.

## Sidebar nav

`STATIC_NAV` reordered. New top section reads:

```
🏠 Home
🌿 Subprojects
✅ Tasks
📚 Docs
📅 Memory
📡 Channels
🛠️ MCPs
🧠 Skills
🧮 Models
✋ Approvals
⏰ Cron
📱 Nodes
⚙️ Config
🩺 Doctor
🔌 RPC
⚙️ Settings
```

Order mirrors OHQ's "live surfaces first" intent — orientation pages (Home, Subprojects, Tasks, Docs, Memory) at the top, ops/debug toward the bottom.

## Builds

| package | result |
| --- | --- |
| `@claw-hq/openclaw-plugin` | clean (0.0.13 → 0.0.16 across the batch) |
| `@claw-hq/web` | clean — final bundle `index-87SEqBWN.js` |
| `@claw-hq/cloud-relay` | not rebuilt this batch (no relay changes) |

Smoke totals across the batch: **81 assertions** (15 + 17 + 30 + 19).

## Frank-action queue (carry into next session)

1. **Plugin reinstall + gateway restart** to bring the new clawhq.docs/memory/tasks methods online. Tarball at `apps/openclaw-plugin/claw-hq-openclaw-plugin-0.0.16.tgz`. Command (matches Phase C step 25):
   ```
   openclaw plugins install ./apps/openclaw-plugin/claw-hq-openclaw-plugin-0.0.16.tgz --force --dangerously-force-unsafe-install
   systemctl --user restart openclaw-gateway.service
   ```
2. **Browser refresh** picks up the new SPA bundle. No APK rebuild needed (server-rendered SPA, WebView wrapper).
3. Optional: pick a specific OHQ surface to screenshot if anything still feels off — chat-surface deltas (typing indicators, animation polish) need that visual reference.

## Status

HEAD `10be743` on `main`. Now **6 ahead of origin** (88bc075 + f8bf229 + f2fde1c + fafff2c + 10af54a + 10be743), NOT pushed per rule.

Days 1 + 2 + 3 of OHQ migration all shipped today. Next on "proceed": iterative screenshot-driven polish, OR retire OHQ entirely once Frank has dual-run for a few days.
