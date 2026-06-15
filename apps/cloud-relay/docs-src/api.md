---
title: API & RPC reference
description: REST endpoints + clawhq.* Gateway methods.
---

# API & RPC reference

Claw HQ exposes a small REST surface for system management plus a Gateway-RPC plugin that adds `clawhq.*` methods on top of OpenClaw's native protocol.

## REST

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET    | `/api/auth/me` | current session user |
| POST   | `/api/auth/login` | exchange credentials for a session cookie |
| POST   | `/api/auth/logout` | revoke session |
| GET    | `/api/system/version` | current Claw HQ version + install method |
| POST   | `/api/system/version/check` | poll GitHub releases for the latest version |
| GET    | `/api/system/openclaw` | OpenClaw install + reachability status |
| GET/POST/DELETE | `/api/system/push/config` | Firebase config storage |
| GET    | `/api/push/init` | APK launch fetch (`google-services.json`) |
| GET/POST/DELETE | `/api/push/devices` | register / list / unregister device tokens |
| POST   | `/api/push/send-test` | fire a test notification |
| GET    | `/api/pairing/tokens` | list pairing tokens |
| POST   | `/api/pairing/tokens` | issue a new pairing token |
| DELETE | `/api/pairing/tokens/:token` | revoke a pairing token |
| GET    | `/api/notifications` | inbox |
| POST   | `/api/notifications/:id/read` | mark one read |
| POST   | `/api/notifications/read-all` | mark all read |
| POST   | `/api/uploads` | multipart upload → returns SHA-256 + URL |
| GET    | `/uploads/:id` | serve an uploaded blob |
| GET    | `/install` | APK landing page |
| GET    | `/install/apk` | APK binary |
| GET    | `/docs/*` | these docs |
| GET    | `/docs/latest-version.json` | version manifest the APK polls for self-update |

## WebSocket

| Path | Purpose |
| ---- | ------- |
| `/ws/client` | Browser / APK → relay. Tunnel envelopes carrying OpenClaw frames. |
| `/ws/agent` | Tunnel agent → relay. Persistent outbound WS from your local OpenClaw. |

The relay is a transparent forwarder; both sides speak OpenClaw's Gateway Protocol v4 directly.

## clawhq.* Gateway methods

Registered by `@claw-hq/openclaw-plugin` (auto-activated at gateway startup). All require an authenticated operator session.

### Projects + sub-projects

- `clawhq.projects.list` — discover projects from `workspaceRoot`
- `clawhq.projects.get` — single project's BRIEF.md + memory/INDEX.md + ROADMAP.md
- `clawhq.subprojects.list` — sub-projects of one project
- `clawhq.subprojects.get` — single sub-project + tasks

### Chats

- `clawhq.chats.{list,create,history,append,rename,delete,search}` — Claw-HQ-native chat storage under `~/.openclaw/clawhq/data/chats/`. Separate from OHQ chats; no cross-read.

### Tasks

- `clawhq.tasks.toggle` — flip a `- [ ]` / `- [x]` checkbox in a sub-project's TASKS.md

### Memory

- `clawhq.memory.{list,get,put,delete}` — read/write workspace-level and project-level memory files

### Plugins (admin)

- `clawhq.plugins.list` — `openclaw plugins list --json`
- `clawhq.plugins.search` — `openclaw plugins search <q> --json`
- `clawhq.plugins.install` — `openclaw plugins install <spec> --json` (requires `operator.admin`)
- `clawhq.plugins.uninstall` — `openclaw plugins uninstall <id> --json` (requires `operator.admin`)

## Broadcast events

The plugin emits `plugin.clawhq.*` events on mutation; the SPA subscribes to keep multi-device views in sync.

- `plugin.clawhq.chat.message` — new message appended (any role)
- `plugin.clawhq.chat.renamed` — chat title changed
- `plugin.clawhq.memory.updated` / `plugin.clawhq.memory.deleted`
- `plugin.clawhq.plugins.changed` — plugin install/uninstall completed

All `plugin.*` broadcasts are scope-gated by OpenClaw (operator.write or operator.admin depending on the registration); pairing-scoped sessions skip them.
