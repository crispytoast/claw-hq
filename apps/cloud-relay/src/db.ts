/**
 * SQLite schema + lightweight query helpers for the cloud relay.
 *
 * Tables:
 *   users          — accounts (email, password hash, display name)
 *   pairing_tokens — opaque tokens the tunnel-agent uses to identify itself
 *                    to the relay; one-to-many per user (each device gets its
 *                    own token so revocation is granular)
 *
 * Chat history is NOT mirrored here — the OpenClaw Gateway is the source of
 * truth. The relay only knows about users and which tunnel is whose.
 */
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: number;
}

export interface PairingTokenRow {
  token: string;
  user_id: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

export interface PushDeviceRow {
  token: string;
  user_id: string;
  platform: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  deep_link: string | null;
  kind: string;
  created_at: number;
  read_at: number | null;
}

let dbInstance: Database.Database | null = null;

export function openDb(path: string): Database.Database {
  if (dbInstance) return dbInstance;
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairing_tokens (
      token         TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      label         TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pairing_tokens_user ON pairing_tokens(user_id);

    CREATE TABLE IF NOT EXISTS push_devices (
      token         TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      platform      TEXT NOT NULL,
      label         TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);

    CREATE TABLE IF NOT EXISTS notifications (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL,
      deep_link     TEXT,
      kind          TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      read_at       INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
  `);
  // Seed a synthetic "owner" user so trusted-lan and shared-secret modes
  // (which share the literal id "owner") satisfy the pairing_tokens and
  // push_devices foreign keys. Real-auth installs ignore this row — those
  // users carry randomUUID() ids.
  db.prepare(
    `INSERT OR IGNORE INTO users (id, email, display_name, password_hash, created_at)
     VALUES ('owner', 'owner@local', 'Owner', '', ?)`,
  ).run(Date.now());
  dbInstance = db;
  return db;
}

export function createUser(
  db: Database.Database,
  args: { email: string; displayName: string; passwordHash: string },
): UserRow {
  const id = randomUUID();
  const created_at = Date.now();
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, args.email, args.displayName, args.passwordHash, created_at);
  return { id, email: args.email, display_name: args.displayName, password_hash: args.passwordHash, created_at };
}

export function findUserByEmail(db: Database.Database, email: string): UserRow | undefined {
  return db
    .prepare(`SELECT * FROM users WHERE email = ?`)
    .get(email) as UserRow | undefined;
}

export function findUserById(db: Database.Database, id: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
}

export function createPairingToken(
  db: Database.Database,
  args: { userId: string; label: string },
): PairingTokenRow {
  const token = `chq_${randomBytes(24).toString("base64url")}`;
  const created_at = Date.now();
  db.prepare(
    `INSERT INTO pairing_tokens (token, user_id, label, created_at, last_used_at)
     VALUES (?, ?, ?, ?, NULL)`,
  ).run(token, args.userId, args.label, created_at);
  return { token, user_id: args.userId, label: args.label, created_at, last_used_at: null };
}

export function findPairingToken(db: Database.Database, token: string): PairingTokenRow | undefined {
  return db
    .prepare(`SELECT * FROM pairing_tokens WHERE token = ?`)
    .get(token) as PairingTokenRow | undefined;
}

export function touchPairingToken(db: Database.Database, token: string): void {
  db.prepare(`UPDATE pairing_tokens SET last_used_at = ? WHERE token = ?`).run(Date.now(), token);
}

export function listPairingTokens(db: Database.Database, userId: string): PairingTokenRow[] {
  return db
    .prepare(`SELECT * FROM pairing_tokens WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as PairingTokenRow[];
}

export function deletePairingToken(db: Database.Database, args: { userId: string; token: string }): boolean {
  const res = db
    .prepare(`DELETE FROM pairing_tokens WHERE user_id = ? AND token = ?`)
    .run(args.userId, args.token);
  return res.changes > 0;
}

// ---------- push_devices ----------

export function upsertPushDevice(
  db: Database.Database,
  args: { userId: string; token: string; platform: string; label: string },
): PushDeviceRow {
  const now = Date.now();
  db.prepare(
    `INSERT INTO push_devices (token, user_id, platform, label, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id,
       platform = excluded.platform,
       label = excluded.label,
       last_used_at = excluded.last_used_at`,
  ).run(args.token, args.userId, args.platform, args.label, now, now);
  return {
    token: args.token,
    user_id: args.userId,
    platform: args.platform,
    label: args.label,
    created_at: now,
    last_used_at: now,
  };
}

export function listPushDevices(db: Database.Database, userId: string): PushDeviceRow[] {
  return db
    .prepare(`SELECT * FROM push_devices WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as PushDeviceRow[];
}

export function listAllPushDevices(db: Database.Database): PushDeviceRow[] {
  return db.prepare(`SELECT * FROM push_devices`).all() as PushDeviceRow[];
}

export function deletePushDevice(db: Database.Database, token: string): boolean {
  const res = db.prepare(`DELETE FROM push_devices WHERE token = ?`).run(token);
  return res.changes > 0;
}

// ---------- notifications ----------

export function createNotification(
  db: Database.Database,
  args: { userId: string; title: string; body: string; deepLink?: string | null; kind: string },
): NotificationRow {
  const id = randomUUID();
  const created_at = Date.now();
  db.prepare(
    `INSERT INTO notifications (id, user_id, title, body, deep_link, kind, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, args.userId, args.title, args.body, args.deepLink ?? null, args.kind, created_at);
  return {
    id,
    user_id: args.userId,
    title: args.title,
    body: args.body,
    deep_link: args.deepLink ?? null,
    kind: args.kind,
    created_at,
    read_at: null,
  };
}

export function listNotifications(
  db: Database.Database,
  args: { userId: string; limit: number },
): NotificationRow[] {
  return db
    .prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(args.userId, args.limit) as NotificationRow[];
}

export function markNotificationRead(
  db: Database.Database,
  args: { userId: string; id: string },
): boolean {
  const res = db
    .prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`)
    .run(Date.now(), args.id, args.userId);
  return res.changes > 0;
}

export function markAllNotificationsRead(db: Database.Database, userId: string): number {
  const res = db
    .prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`)
    .run(Date.now(), userId);
  return res.changes;
}

/**
 * Mark every notification with an exact deep_link match as read. Used when the
 * user lands on a chat via a /chat-detail/<prefix> push deep link so the bell
 * badge stops ballooning. Tapping a push has never marked anything read on its
 * own — only "Mark all read" or the in-app inbox did — so the badge grew
 * unbounded until 2026-06-24 when this was added.
 */
export function markNotificationsReadByDeepLink(
  db: Database.Database,
  args: { userId: string; deepLink: string },
): number {
  const res = db
    .prepare(
      `UPDATE notifications SET read_at = ?
       WHERE user_id = ? AND deep_link = ? AND read_at IS NULL`,
    )
    .run(Date.now(), args.userId, args.deepLink);
  return res.changes;
}

export function unreadNotificationCount(db: Database.Database, userId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read_at IS NULL`)
    .get(userId) as { c: number };
  return row.c;
}
