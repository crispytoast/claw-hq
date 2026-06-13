/**
 * Tiny fetch helpers for the relay's REST API.
 * All requests include credentials so the session cookie flows.
 */
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
}

export interface PairingToken {
  token: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface IssuedPairingToken {
  pairingToken: string;
  label: string;
  createdAt: number;
  pairCommand: string;
  relayUrl: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    const msg = (body && typeof body === "object" && "error" in body && typeof body.error === "string")
      ? body.error
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  async me(): Promise<User> {
    const { user } = await call<{ user: User }>("/api/auth/me");
    return user;
  },
  async login(email: string, password: string): Promise<User> {
    const { user } = await call<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    return user;
  },
  async signup(email: string, password: string, displayName: string): Promise<User> {
    const { user } = await call<{ user: User }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName }),
    });
    return user;
  },
  async logout(): Promise<void> {
    await call<{ ok: true }>("/api/auth/logout", { method: "POST" });
  },
  async listPairingTokens(): Promise<PairingToken[]> {
    const { tokens } = await call<{ tokens: PairingToken[] }>("/api/pairing/tokens");
    return tokens;
  },
  async issuePairingToken(label: string): Promise<IssuedPairingToken> {
    return await call<IssuedPairingToken>("/api/pairing/tokens", {
      method: "POST",
      body: JSON.stringify({ label }),
    });
  },
  async revokePairingToken(token: string): Promise<void> {
    await call<{ ok: true }>(`/api/pairing/tokens/${encodeURIComponent(token)}`, { method: "DELETE" });
  },
};
