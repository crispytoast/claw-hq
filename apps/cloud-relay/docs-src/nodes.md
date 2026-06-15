---
title: Nodes
description: Pair a phone, laptop, or headless machine as an OpenClaw node.
---

# Nodes

A **node** is a companion device that exposes a command surface to the Gateway over WebSocket — canvas, camera, screen, location, voice, talk. Claw HQ surfaces node pairing and approval in the **Nodes** nav page.

## Why pair a node?

- **Camera/mic on your phone** — the model can ask for a photo or recording, your phone provides it
- **Canvas/screen on your laptop** — long-running headless boxes can borrow your laptop's screen for visual tasks
- **`system.run` on a node host** — run shell commands on a machine other than the one running the Gateway

## Pair a phone

Open the APK → menu → "Pair as node". The phone sends a `connect` with `role: "node"` and the gateway creates a pending pairing request. Approve it from the **Nodes** page in Claw HQ.

## Pair a laptop

On the laptop:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "My Laptop"
```

Then approve in the Nodes page. For loopback gateways (the default in local mode), tunnel through SSH first — see [OpenClaw's node docs](https://docs.openclaw.ai/nodes) for the `ssh -L` recipe.

## Approve / reject

The Nodes page polls `node.list` + `node.pair.list` and shows:

- **Pending requests** — Approve / Reject buttons inline
- **Active pairings** — capability chips, last-seen timestamp, Rename + Remove

Approvals require `operator.pairing` scope. If the command list includes `system.run` / `system.run.prepare` / `system.which`, the scope check escalates to `operator.pairing + operator.admin`.

## Invoke a node

Once paired, the agent can call `node.invoke` to ask the node to run one of its declared commands. From the chat, this is automatic — the model picks the right node. From the **RPC Console**, you can invoke directly:

```json
{
  "method": "node.invoke",
  "params": {
    "node": "iphone-15",
    "command": "camera.capture",
    "args": { "facing": "back" }
  }
}
```

## Background presence

Nodes can ping `node.event` with `event: "node.presence.alive"` to record durable background presence (e.g. a phone backgrounded but still responding to silent pushes). The Nodes page shows the last-seen reason next to each node — `connect`, `silent_push`, `background`, etc.
