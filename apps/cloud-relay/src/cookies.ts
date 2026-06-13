/**
 * Tiny HMAC-signed session cookie. No JWT lib — we just sign the user id
 * with a server secret and verify on each request.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "chq_session";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

interface SessionPayload {
  uid: string;
  /** Unix seconds at which this cookie was issued. */
  iat: number;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 2 ? "==" : input.length % 4 === 3 ? "=" : "";
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: SessionPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

function verify(value: string, secret: string): SessionPayload | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString("utf-8")) as SessionPayload;
    if (typeof parsed.uid !== "string" || typeof parsed.iat !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export const sessionCookie = {
  name: COOKIE_NAME,
  maxAgeSeconds: COOKIE_MAX_AGE_S,
  issue(uid: string, secret: string): string {
    return sign({ uid, iat: Math.floor(Date.now() / 1000) }, secret);
  },
  parse(value: string | undefined, secret: string): string | null {
    if (!value) return null;
    const payload = verify(value, secret);
    return payload?.uid ?? null;
  },
};
