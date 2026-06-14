# @claw-hq/openclaw-plugin

OpenClaw plugin that backs the [Claw HQ](../../README.md) self-hosted GUI. Loaded in-process by the user's local OpenClaw Gateway, it exposes Gateway RPC methods on the `clawhq.*` prefix that the Claw HQ web client calls through the existing tunnel — no new transport, no new auth surface.

## Status — v0.0.2 (Phase B step 2)

`clawhq.health`, `clawhq.projects.list`, and `clawhq.projects.get` are wired and reading from `agents.defaults.workspace` by default. The Sidebar's Projects group renders real project rows. Remaining surfaces below are still placeholders.

## Install (after the dangerous-code scan landmine)

`openclaw plugins install <pnpm-workspace-path>` is blocked by the safety scan because pnpm symlinks `node_modules/openclaw` into its `.pnpm` store outside the install root. Use a clean tarball:

```bash
pnpm --filter @claw-hq/openclaw-plugin build
( cd /home/jesse/claw-hq/apps/openclaw-plugin && rm -f *.tgz && npm pack )
openclaw plugins install --force /home/jesse/claw-hq/apps/openclaw-plugin/claw-hq-openclaw-plugin-*.tgz
openclaw gateway restart
```

## Planned RPCs

| Method                       | Purpose                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `clawhq.health`              | Liveness + scaffold marker (returns plugin id, version, workspace, surfaces). |
| `clawhq.projects.list`       | List `<workspaceRoot>/*` as Claw HQ projects.                                 |
| `clawhq.projects.get`        | Project memory snapshot (BRIEF / ROADMAP / TASKS / memory/INDEX).             |
| `clawhq.chats.list`          | Chats scoped to a project.                                                    |
| `clawhq.chats.history`       | Messages for one chat.                                                        |
| `clawhq.chats.append`        | Append a message to a chat + fan-out to live-feed subscribers.                |
| `clawhq.subprojects.tasks.toggle` | Flip a GFM `- [ ]` / `- [x]` task in `TASKS.md`.                          |
| `clawhq.uploads.put`         | Persist an upload (image / PDF / CSV / JSON / YAML).                          |
| `clawhq.memory.read` / `write` | Read/write memory files via the existing OpenClaw `memory.*` RPCs.          |
| `clawhq.events.subscribe`    | Cross-device live feed (mirror of OHQ `chats/[id]/events` SSE).               |

## Verify load

From the Claw HQ web client → **RPC Console** page, call method `clawhq.health` with empty params. Expected response:

```json
{
  "ok": true,
  "plugin": "clawhq",
  "version": "0.0.1",
  "workspaceRoot": "/home/jesse/.openclaw/workspace",
  "surfaces": [{ "id": "projects.list", "status": "planned" }, ...]
}
```

## Config

Plugin config lives under `plugins.entries.clawhq.config` in `~/.openclaw/config.json`:

```json5
{
  plugins: {
    entries: {
      clawhq: {
        enabled: true,
        config: {
          workspaceRoot: "/home/jesse/.openclaw/workspace",
        },
      },
    },
  },
}
```

`workspaceRoot` may also come from the `CLAWHQ_WORKSPACE_ROOT` env var; explicit config wins.

## Why a plugin and not a Claw HQ server feature

Locked Option B (2026-06-13 PM): hosting project/chat/upload state inside OpenClaw rather than the Claw HQ relay keeps the data with the user's existing OpenClaw install, lets these surfaces show up in any OpenClaw front-end (not just Claw HQ), and means the Claw HQ relay stays a transparent tunnel.
