---
title: Claw HQ
description: A polished cross-device interface for your local OpenClaw.
---

# Claw HQ

Claw HQ is a **self-hosted, cross-device interface for [OpenClaw](https://openclaw.ai)**. You run it on your laptop, phone, or VPS, and every Claude / GPT / Ollama turn flows through your local OpenClaw daemon — never a third party.

- **Phone, laptop, desktop** — one relay, every device, real-time sync
- **No API keys in Claw HQ** — OpenClaw owns provider auth
- **Native APK** with push notifications when an agent finishes a long run
- **PWA-installable** web client with offline shell
- **Three auth modes** that match real deployments (trusted LAN, shared secret, real accounts)
- **Every OpenClaw RPC** has a UI surface — Channels, MCPs, Skills, Models, Approvals, Cron, Doctor, RPC console, Nodes, Plugins, Memory

## Get started

- [Install](/docs/install)
- [Quickstart](/docs/quickstart)
- [Auth modes](/docs/auth)
- [APK + push notifications](/docs/apk)
- [Pair a phone as a camera/mic node](/docs/nodes)
- [RPC reference](/docs/api)

## Why self-hosted?

OpenClaw's whole pitch is "own your stack." A hosted control plane for it would defeat that. Claw HQ is one binary, one config file, one Firebase project (yours) — and it's done.

## What's running here

This docs site is served by the relay itself at `/docs`. There is no separate domain or static host to chase. If you can reach Claw HQ, you can reach the docs.
