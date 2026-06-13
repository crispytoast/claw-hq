/**
 * Pluggable auth for the relay's HTTP + WS endpoints.
 *
 * Three modes, chosen by config.auth.mode:
 *   - trusted-lan:   no auth. Every connection is the synthetic owner. Use only on
 *                    loopback or trusted networks.
 *   - shared-secret: one passphrase. /api/auth/login accepts it, sets a signed cookie.
 *                    Multiple browsers share the same "owner" identity.
 *   - real-auth:     email+password accounts in SQLite. Multi-user supported.
 *
 * All modes return an `OwnerSession` (id + label). The id is opaque to the relay;
 * routing logic only cares about who-is-this.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import type Database from "better-sqlite3";
import { sessionCookie } from "./cookies.js";
import {
  createPairingToken,
  createUser,
  deletePairingToken,
  findUserByEmail,
  findUserById,
  listPairingTokens,
  type UserRow,
} from "./db.js";
import type { ResolvedConfig } from "./config.js";

export interface OwnerSession {
  id: string;
  displayName: string;
}

const TRUSTED_LAN_OWNER: OwnerSession = { id: "owner", displayName: "Owner" };
const SHARED_SECRET_OWNER: OwnerSession = { id: "owner", displayName: "Owner" };

function publicUser(u: UserRow): { id: string; email: string; displayName: string; createdAt: number } {
  return { id: u.id, email: u.email, displayName: u.display_name, createdAt: u.created_at };
}

function setSessionCookie(reply: FastifyReply, uid: string, config: ResolvedConfig): void {
  reply.setCookie(sessionCookie.name, sessionCookie.issue(uid, config.cookieSecret), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: sessionCookie.maxAgeSeconds,
  });
}

/**
 * Resolve the current request's owner. Returns null if unauthenticated;
 * returns the synthetic owner in trusted-lan mode regardless of cookies.
 */
export function resolveOwner(
  req: FastifyRequest,
  config: ResolvedConfig,
  db: Database.Database,
): OwnerSession | null {
  if (config.auth.mode === "trusted-lan") return TRUSTED_LAN_OWNER;
  const uid = sessionCookie.parse(req.cookies[sessionCookie.name], config.cookieSecret);
  if (!uid) return null;
  if (config.auth.mode === "shared-secret") {
    return uid === "owner" ? SHARED_SECRET_OWNER : null;
  }
  // real-auth
  const user = findUserById(db, uid);
  return user ? { id: user.id, displayName: user.display_name } : null;
}

interface AuthDeps {
  db: Database.Database;
  config: ResolvedConfig;
}

export async function registerAuthRoutes(fastify: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { db, config } = deps;

  // ---------------- /api/auth/me ----------------
  // Always available. In trusted-lan mode always returns the owner.
  fastify.get("/api/auth/me", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated", mode: config.auth.mode };
    }
    return { user: { id: owner.id, displayName: owner.displayName }, mode: config.auth.mode };
  });

  fastify.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(sessionCookie.name, { path: "/" });
    return { ok: true };
  });

  // ---------------- mode-specific routes ----------------
  if (config.auth.mode === "shared-secret") {
    fastify.post<{ Body: { password?: string } }>("/api/auth/login", async (req, reply) => {
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!password) {
        reply.code(400);
        return { error: "password required" };
      }
      const hash = config.auth.sharedSecretHash;
      if (!hash) {
        reply.code(500);
        return { error: "shared secret not configured" };
      }
      const ok = await bcrypt.compare(password, hash);
      if (!ok) {
        reply.code(401);
        return { error: "incorrect password" };
      }
      setSessionCookie(reply, "owner", config);
      return { user: { id: "owner", displayName: "Owner" }, mode: "shared-secret" };
    });
  }

  if (config.auth.mode === "real-auth") {
    fastify.post<{ Body: { email?: string; password?: string; displayName?: string } }>(
      "/api/auth/signup",
      async (req, reply) => {
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
        if (!email.includes("@") || password.length < 8 || displayName.length === 0) {
          reply.code(400);
          return { error: "email, password (≥8 chars), and displayName required" };
        }
        if (findUserByEmail(db, email)) {
          reply.code(409);
          return { error: "email already registered" };
        }
        const passwordHash = await bcrypt.hash(password, 10);
        const user = createUser(db, { email, displayName, passwordHash });
        setSessionCookie(reply, user.id, config);
        return { user: publicUser(user) };
      },
    );

    fastify.post<{ Body: { email?: string; password?: string } }>("/api/auth/login", async (req, reply) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const user = findUserByEmail(db, email);
      if (!user) {
        reply.code(401);
        return { error: "invalid credentials" };
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        reply.code(401);
        return { error: "invalid credentials" };
      }
      setSessionCookie(reply, user.id, config);
      return { user: publicUser(user) };
    });
  }

  // ---------------- pairing tokens ----------------
  // Always available — used for split-process tunnel pairing.
  fastify.post<{ Body: { label?: string } }>("/api/pairing/tokens", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const label = typeof req.body?.label === "string" && req.body.label.trim().length > 0
      ? req.body.label.trim()
      : "unnamed device";
    const token = createPairingToken(db, { userId: owner.id, label });
    return {
      pairingToken: token.token,
      label: token.label,
      createdAt: token.created_at,
      pairCommand: `claw-hq pair ${token.token} --relay ${toWs(config.publicUrl)}`,
      relayUrl: config.publicUrl,
    };
  });

  fastify.get("/api/pairing/tokens", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const rows = listPairingTokens(db, owner.id);
    return {
      tokens: rows.map((r) => ({
        token: r.token,
        label: r.label,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      })),
    };
  });

  fastify.delete<{ Params: { token: string } }>("/api/pairing/tokens/:token", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const ok = deletePairingToken(db, { userId: owner.id, token: req.params.token });
    if (!ok) {
      reply.code(404);
      return { error: "pairing token not found" };
    }
    return { ok: true };
  });
}

function toWs(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws");
}
