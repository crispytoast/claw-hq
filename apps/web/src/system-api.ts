/**
 * Tiny fetch helpers for /api/system/*.
 */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text(); }
    const msg = (body && typeof body === "object" && "error" in body && typeof body.error === "string")
      ? body.error
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  installMethod: "npm" | "docker" | "source" | "unknown";
}

export interface UpdateCheck {
  current: string;
  latest: string;
  updateAvailable: boolean;
  releaseUrl?: string | null;
  note?: string;
}

export interface OpenClawStatus {
  installed: boolean;
  configPath: string;
  gatewayUrl?: string;
  reachable?: boolean;
  error?: string;
}

export interface PushConfigStatus {
  configured: boolean;
  projectId?: string;
  updatedAt?: number;
}

export const systemApi = {
  version: () => call<VersionInfo>("/api/system/version"),
  checkUpdates: () => call<UpdateCheck>("/api/system/version/check", { method: "POST" }),
  openclaw: () => call<OpenClawStatus>("/api/system/openclaw"),
  pushConfig: () => call<PushConfigStatus>("/api/system/push/config"),
  setPushConfig: (body: { projectId: string; googleServicesJson?: unknown; serviceAccountJson?: unknown }) =>
    call<PushConfigStatus>("/api/system/push/config", { method: "POST", body: JSON.stringify(body) }),
  clearPushConfig: () => call<{ ok: true }>("/api/system/push/config", { method: "DELETE" }),
};
