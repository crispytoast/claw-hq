/**
 * /api/push/* — device registration + in-app notification inbox.
 *
 * Two halves:
 *   1. Devices: APK posts its FCM registration token at launch (and again on
 *      refresh). Relay stores it under the current user.
 *   2. Notifications: persisted history so the SPA inbox can render past
 *      pushes. The trigger code (ws-routing.ts) calls deliverNotification()
 *      which persists + fans out via FCM.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { resolveOwner } from "./auth.js";
import type { ResolvedConfig } from "./config.js";
import {
  upsertPushDevice,
  listPushDevices,
  listAllPushDevices,
  deletePushDevice,
  createNotification,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  markNotificationsReadByDeepLink,
  unreadNotificationCount,
  type NotificationRow,
} from "./db.js";
import { sendFcmMessage, pushSendingConfigured } from "./push-sender.js";

interface PushDeps {
  db: Database.Database;
  config: ResolvedConfig;
}

export interface DeliverNotificationArgs {
  userId: string;
  title: string;
  body: string;
  kind: string;
  deepLink?: string | null;
  /** Optional extra data sent with the FCM payload (for client-side routing). */
  data?: Record<string, string>;
}

/**
 * Persist a notification + fan out to every registered device for this user.
 * Tolerant of FCM not being configured (logs and returns), so trigger code
 * can call it unconditionally.
 */
export async function deliverNotification(
  deps: PushDeps,
  args: DeliverNotificationArgs,
): Promise<{ stored: NotificationRow; pushed: number; failed: number }> {
  const { db, config } = deps;
  const stored = createNotification(db, {
    userId: args.userId,
    title: args.title,
    body: args.body,
    deepLink: args.deepLink ?? null,
    kind: args.kind,
  });

  if (!pushSendingConfigured(config)) {
    return { stored, pushed: 0, failed: 0 };
  }

  const devices = listPushDevices(db, args.userId);
  if (devices.length === 0) return { stored, pushed: 0, failed: 0 };

  let pushed = 0;
  let failed = 0;
  await Promise.all(
    devices.map(async (d) => {
      try {
        const res = await sendFcmMessage(config, {
          token: d.token,
          notification: { title: args.title, body: args.body },
          data: {
            notificationId: stored.id,
            kind: args.kind,
            ...(args.deepLink ? { deepLink: args.deepLink } : {}),
            ...(args.data ?? {}),
          },
        });
        if (res.ok) {
          pushed++;
        } else {
          failed++;
          if (res.invalidToken) {
            deletePushDevice(db, d.token);
            console.log(`[push] dropped invalid token (status=${res.status})`);
          } else {
            console.warn(`[push] send failed status=${res.status} body=${(res.body ?? "").slice(0, 200)}`);
          }
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[push] send threw: ${msg}`);
      }
    }),
  );
  return { stored, pushed, failed };
}

export async function registerPushRoutes(fastify: FastifyInstance, deps: PushDeps): Promise<void> {
  const { db, config } = deps;

  // ---------------- device registration ----------------
  fastify.post<{ Body: { token?: string; platform?: string; label?: string } }>(
    "/api/push/devices",
    async (req, reply) => {
      const owner = resolveOwner(req, config, db);
      if (!owner) {
        reply.code(401);
        return { error: "not authenticated" };
      }
      const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
      if (!token) {
        reply.code(400);
        return { error: "token required" };
      }
      const platform = typeof req.body?.platform === "string" ? req.body.platform.trim() : "unknown";
      const label = typeof req.body?.label === "string" && req.body.label.trim().length > 0
        ? req.body.label.trim()
        : `${platform} device`;
      const row = upsertPushDevice(db, { userId: owner.id, token, platform, label });
      return {
        ok: true,
        device: {
          token: row.token,
          platform: row.platform,
          label: row.label,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        },
      };
    },
  );

  fastify.get("/api/push/devices", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const devices = listPushDevices(db, owner.id);
    return {
      devices: devices.map((d) => ({
        token: d.token,
        platform: d.platform,
        label: d.label,
        createdAt: d.created_at,
        lastUsedAt: d.last_used_at,
      })),
    };
  });

  fastify.delete<{ Params: { token: string } }>("/api/push/devices/:token", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    // Devices live in a flat table; only owner can delete (verify ownership first).
    const owned = listPushDevices(db, owner.id).some((d) => d.token === req.params.token);
    if (!owned) {
      reply.code(404);
      return { error: "device not found" };
    }
    deletePushDevice(db, req.params.token);
    return { ok: true };
  });

  // ---------------- notifications inbox ----------------
  fastify.get<{ Querystring: { limit?: string } }>("/api/notifications", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const rows = listNotifications(db, { userId: owner.id, limit });
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        deepLink: n.deep_link,
        kind: n.kind,
        createdAt: n.created_at,
        readAt: n.read_at,
      })),
      unread: unreadNotificationCount(db, owner.id),
    };
  });

  fastify.post<{ Params: { id: string } }>("/api/notifications/:id/read", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const ok = markNotificationRead(db, { userId: owner.id, id: req.params.id });
    return { ok };
  });

  fastify.post("/api/notifications/read-all", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const changed = markAllNotificationsRead(db, owner.id);
    return { ok: true, marked: changed };
  });

  // Mark every notification whose deep_link points at a specific clawhq chat
  // as read. Called by ChatApp on /chat-detail/<prefix> deep-link land so the
  // user opening the chat actually drains the bell, instead of the badge
  // ballooning forever.
  fastify.post<{ Body: { chatIdPrefix?: string } }>(
    "/api/notifications/read-by-chat-prefix",
    async (req, reply) => {
      const owner = resolveOwner(req, config, db);
      if (!owner) {
        reply.code(401);
        return { error: "not authenticated" };
      }
      const prefix = typeof req.body?.chatIdPrefix === "string" ? req.body.chatIdPrefix.trim() : "";
      if (!prefix || !/^[A-Za-z0-9-]{1,36}$/.test(prefix)) {
        reply.code(400);
        return { error: "invalid chatIdPrefix" };
      }
      const deepLink = `/chat-detail/${prefix}`;
      const changed = markNotificationsReadByDeepLink(db, { userId: owner.id, deepLink });
      return { ok: true, marked: changed };
    },
  );

  // ---------------- send-test (debug helper, owner only) ----------------
  fastify.post<{ Body: { title?: string; body?: string } }>("/api/push/send-test", async (req, reply) => {
    const owner = resolveOwner(req, config, db);
    if (!owner) {
      reply.code(401);
      return { error: "not authenticated" };
    }
    const title = typeof req.body?.title === "string" ? req.body.title : "Claw HQ test";
    const body = typeof req.body?.body === "string" ? req.body.body : "Push is working.";
    const result = await deliverNotification(
      { db, config },
      { userId: owner.id, title, body, kind: "test" },
    );
    return {
      ok: true,
      notificationId: result.stored.id,
      pushed: result.pushed,
      failed: result.failed,
    };
  });

  // Light helper: return registered device count for any owner.
  // Used by ws-routing when there's no single user binding (trusted-lan single-tenant).
  fastify.get("/api/push/__diag", async (_req, reply) => {
    const all = listAllPushDevices(db);
    reply.code(200);
    return { totalDevices: all.length };
  });
}
