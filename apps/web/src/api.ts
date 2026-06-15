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
  // Only declare a JSON content-type when there's a body. Fastify rejects
  // empty-body requests with application/json (DELETE /api/pairing/tokens/:t
  // would 400 otherwise — caught by phaseC16-pairing-ui-test).
  const headers = init.body
    ? { "Content-Type": "application/json", ...(init.headers ?? {}) }
    : { ...(init.headers ?? {}) };
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
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
  async meExtended(): Promise<{ user: User; mode: string; runTunnel: boolean }> {
    return await call<{ user: User; mode: string; runTunnel: boolean }>("/api/auth/me");
  },
  async login(email: string, password: string): Promise<User> {
    const { user } = await call<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    return user;
  },
  async loginSharedSecret(password: string): Promise<User> {
    const { user } = await call<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    return user;
  },
  async detectAuthMode(): Promise<string> {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    try {
      const body = await res.json() as { mode?: unknown };
      return typeof body?.mode === "string" ? body.mode : "trusted-lan";
    } catch {
      return "trusted-lan";
    }
  },
  async getAuthMode(): Promise<{ mode: string; hasPassphrase: boolean }> {
    return await call<{ mode: string; hasPassphrase: boolean }>("/api/auth/mode");
  },
  async setSharedSecret(passphrase: string): Promise<{ mode: string }> {
    return await call<{ ok: true; mode: string }>("/api/auth/mode", {
      method: "POST",
      body: JSON.stringify({ passphrase }),
    });
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
