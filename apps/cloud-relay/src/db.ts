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
  `);
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
