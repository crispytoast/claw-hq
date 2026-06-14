# @claw-hq/openclaw-plugin

OpenClaw plugin that backs the [Claw HQ](../../README.md) self-hosted GUI. Loaded in-process by the user's local OpenClaw Gateway, it exposes Gateway RPC methods on the `clawhq.*` prefix that the Claw HQ web client calls through the existing tunnel — no new transport, no new auth surface.

## Status — v0.0.3 (Phase B step 3)

`clawhq.health`, `clawhq.projects.*`, and `clawhq.chats.*` are wired. Project rows in the Sidebar expand to show their chats with a "+ New chat" button. Chats persist as one JSON-per-chat under `~/.openclaw/clawhq/data/chats/` — fully independent of OHQ's `.oswald-hq/chats/`. Chat detail screen + LLM round-trip land in step 3b.

## Install (after the dangerous-code scan landmine)

`openclaw plugins install <pnpm-workspace-path>` is blocked by the safety scan because pnpm symlinks `node_modules/openclaw` into its `.pnpm` store outside the install root. Use a clean tarball:

```bash
pnpm --filter @claw-hq/openclaw-plugin build
( cd /home/jesse/claw-hq/apps/openclaw-plugin && rm -f *.tgz && npm pack )
openclaw plugins install --force /home/jesse/claw-hq/apps/openclaw-plugin/claw-hq-openclaw-plugin-*.tgz
openclaw gateway restart
```

## RPC surface

| Method                       | Scope          | Purpose                                                                       |
| ---------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `clawhq.health`              | operator.read  | Liveness + version + registered method list.                                  |
| `clawhq.projects.list`       | operator.read  | List `<workspaceRoot>/projects/*` summaries.                                  |
| `clawhq.projects.get`        | operator.read  | Project detail (BRIEF / ROADMAP / TASKS / memory/INDEX + sub-projects).       |
| `clawhq.chats.list`          | operator.read  | Chat summaries, optionally filtered by `projectSlug`.                         |
| `clawhq.chats.create`        | operator.write | Create a chat scoped to a project. Returns the new `Chat`.                    |
| `clawhq.chats.history`       | operator.read  | Full `Chat` (messages included) for one `chatId`.                             |
| `clawhq.chats.append`        | operator.write | Append `{role, content}` to a chat. Returns the new `ChatMessage`.            |
| `clawhq.chats.delete`        | operator.write | Delete a chat by id.                                                          |
| `clawhq.subprojects.tasks.toggle` | (planned) | Flip a GFM `- [ ]` / `- [x]` task in `TASKS.md`.                              |
| `clawhq.uploads.put`         | (planned)      | Persist an upload (image / PDF / CSV / JSON / YAML).                          |
| `clawhq.memory.read` / `write` | (planned)    | Read/write memory files.                                                      |
| `clawhq.events.subscribe`    | (planned)      | Cross-device live feed (mirror of OHQ `chats/[id]/events` SSE).               |

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
