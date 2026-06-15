---
title: Auth modes
description: Three modes that match common deployment shapes.
---

# Auth modes

Claw HQ ships with three auth modes. Pick whichever matches the network you're on. Re-run `claw-hq init` to switch.

## trusted-lan (default for local)

Nobody logs in. The relay accepts every request as the owner. Use this on your laptop, a single-user Tailnet, or any network where you fully control who can reach the port.

```json
{ "auth": { "mode": "trusted-lan" } }
```

What you trade: zero friction; anyone who hits the port becomes you.

## shared-secret

One passphrase, bcrypt-hashed at rest, served via a signed cookie after the user enters it once. Good for small teams sharing one box.

```json
{ "auth": { "mode": "shared-secret", "secretHash": "<bcrypt-hash>" } }
```

`claw-hq init` will offer to set this for you — paste a passphrase, it bcrypts and saves the hash. The relay never stores the plain passphrase.

## real-auth

Email + password per user, stored in the relay's SQLite DB. Pick this if you're running a small multi-user instance (e.g. you + a few collaborators on the same Tailnet).

```json
{ "auth": { "mode": "real-auth" } }
```

The first registration becomes the owner; all subsequent users need an invite token issued through the Pairing tab.

## Cookies

Whichever mode you pick, the session cookie is set with `HttpOnly`, `SameSite=Lax`, and `Secure` when the request came in over HTTPS. The relay automatically detects HTTPS via `X-Forwarded-Proto` when behind a reverse proxy (`trustProxy` is on).

## TLS

In production, terminate TLS in front of the relay — Tailscale Serve, Caddy, Cloudflare Tunnel, or nginx all work. Phase C step 23 shipped Tailscale-Serve integration that the CLI can set up for you:

```bash
claw-hq tls-setup
```

That binds Tailscale Serve to port 443 and proxies to localhost:3838. After that, your public URL is `https://<host>.<tailnet>.ts.net`.
