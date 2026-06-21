/**
 * FCM HTTP v1 sender.
 *
 * Signs a short-lived JWT with the user's service-account JSON, exchanges it
 * for an OAuth access token, and POSTs to
 *   https://fcm.googleapis.com/v1/projects/<project-id>/messages:send
 *
 * No firebase-admin dependency — Node's built-in `crypto` does the signing.
 * Access tokens are cached in-process until ~50 s before expiry.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSign } from "node:crypto";
import type { ResolvedConfig } from "./config.js";

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

interface PushConfigOnDisk {
  projectId?: string;
  serviceAccountJson?: ServiceAccount;
  googleServicesJson?: Record<string, unknown>;
  updatedAt?: number;
}

export interface FcmNotification {
  title: string;
  body: string;
}

export interface FcmSendArgs {
  token: string;
  notification: FcmNotification;
  /** Optional data payload (string values only — FCM requires it). */
  data?: Record<string, string>;
}

export interface FcmSendResult {
  ok: boolean;
  status: number;
  /** The token the FCM API says is permanently invalid — caller should delete it. */
  invalidToken?: boolean;
  /** Raw response body for logging. */
  body?: string;
  /** FCM message name on success: projects/<proj>/messages/<id>. */
  name?: string;
}

const TOKEN_CACHE: Map<string, { token: string; expiresAt: number }> = new Map();

function pushConfigPath(config: ResolvedConfig): string {
  return resolve(config.dataDir, "push-config.json");
}

export function readPushConfigFromDisk(config: ResolvedConfig): PushConfigOnDisk | null {
  const path = pushConfigPath(config);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PushConfigOnDisk;
  } catch {
    return null;
  }
}

/** Returns true if a serviceAccountJson is present — i.e. the sender can send. */
export function pushSendingConfigured(config: ResolvedConfig): boolean {
  const pc = readPushConfigFromDisk(config);
  return Boolean(pc?.serviceAccountJson?.private_key && pc?.serviceAccountJson?.client_email);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signJwt(sa: ServiceAccount): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: sa.private_key_id })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })));
  const toSign = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(toSign);
  const signature = base64url(signer.sign(sa.private_key));
  return `${toSign}.${signature}`;
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const cacheKey = sa.private_key_id;
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 50_000) return cached.token;

  const assertion = signJwt(sa);
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`FCM oauth exchange failed: ${res.status} ${json.error ?? ""} ${json.error_description ?? ""}`);
  }
  const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
  TOKEN_CACHE.set(cacheKey, { token: json.access_token, expiresAt });
  return json.access_token;
}

export async function sendFcmMessage(
  config: ResolvedConfig,
  args: FcmSendArgs,
): Promise<FcmSendResult> {
  const pc = readPushConfigFromDisk(config);
  if (!pc?.serviceAccountJson || !pc.projectId) {
    return { ok: false, status: 0, body: "push not configured" };
  }
  const sa = pc.serviceAccountJson;
  const accessToken = await getAccessToken(sa);

  const url = `https://fcm.googleapis.com/v1/projects/${pc.projectId}/messages:send`;
  // Notification+data hybrid payload. The top-level `notification` block lets
  // Android's system tray render the heads-up automatically when the app is
  // backgrounded or its process has been killed by Samsung One UI battery
  // optimization — `onMessageReceived` is not reliably called for data-only
  // messages in those states (regression observed 2026-06-21 after the
  // 2026-06-16 data-only switch). Title/body are also mirrored into `data`
  // so the new APK's `onMessageReceived` foreground-suppression path can
  // read them when the app IS alive and on a different chat than the one
  // that fired the push. Foreground delivery still hits `onMessageReceived`
  // (FCM fires it whenever the app process is running, regardless of
  // whether a notification block is present), so suppression keeps working.
  const message = {
    message: {
      token: args.token,
      notification: {
        title: args.notification.title,
        body: args.notification.body,
      },
      data: {
        title: args.notification.title,
        body: args.notification.body,
        ...(args.data ?? {}),
      },
      android: {
        priority: "HIGH",
        notification: { sound: "default" },
      },
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  if (res.ok) {
    let name: string | undefined;
    try { name = (JSON.parse(text) as { name?: string }).name; } catch {}
    return { ok: true, status: res.status, name, body: text };
  }
  // 404 / UNREGISTERED / INVALID_ARGUMENT for token means we should drop the token.
  const lower = text.toLowerCase();
  const invalidToken = res.status === 404
    || lower.includes("unregistered")
    || lower.includes("invalid registration token")
    || lower.includes("not a valid fcm registration token");
  return { ok: false, status: res.status, invalidToken, body: text };
}
