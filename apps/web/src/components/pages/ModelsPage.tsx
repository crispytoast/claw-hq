import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { usePageRpc } from "./usePageRpc.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface ModelEntry {
  id: string;
  provider?: string;
  label?: string;
  contextWindow?: number;
  capabilities?: string[];
  isDefault?: boolean;
}

interface ModelsList {
  models?: ModelEntry[];
  entries?: ModelEntry[];
}

interface SessionRow {
  sessionKey?: string;
  key?: string;
  label?: string;
  agentId?: string;
  model?: string;
  lastActivityMs?: number;
}

interface SessionsList {
  sessions?: SessionRow[];
  rows?: SessionRow[];
  items?: SessionRow[];
}

interface PatchResult {
  resolvedModel?: string;
  model?: string;
}

type OverrideState =
  | { kind: "idle" }
  | { kind: "running"; sessionKey: string; modelId: string }
  | { kind: "ok"; sessionKey: string; modelId: string }
  | { kind: "error"; sessionKey: string; modelId: string; message: string };

function sessionKeyOf(row: SessionRow): string | null {
  return row.sessionKey ?? row.key ?? null;
}

function sessionsFrom(resp: SessionsList | null): SessionRow[] {
  if (!resp) return [];
  return resp.sessions ?? resp.rows ?? resp.items ?? [];
}

/**
 * models.list — catalog of every model OpenClaw can route to + per-session
 * override via sessions.patch. Picker shows live session rows; selecting one
 * activates per-row "Use here" buttons that flip that session's model.
 */
export function ModelsPage({ client, status }: Props) {
  const { data, loading, error, refresh } = usePageRpc<ModelsList>(client, status, "models.list");
  const models = useMemo(
    () => (data?.models ?? data?.entries ?? []) as ModelEntry[],
    [data],
  );

  // Group by provider for legibility.
  const grouped = useMemo(() => {
    const g = new Map<string, ModelEntry[]>();
    for (const m of models) {
      const p = m.provider ?? "other";
      if (!g.has(p)) g.set(p, []);
      g.get(p)!.push(m);
    }
    return g;
  }, [models]);

  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessErr, setSessErr] = useState<string | null>(null);
  const [sessLoading, setSessLoading] = useState(false);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [override, setOverride] = useState<OverrideState>({ kind: "idle" });
  /** Local map sessionKey → currently-applied model id (after a successful patch). */
  const [applied, setApplied] = useState<Record<string, string>>({});

  const refreshSessions = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setSessLoading(true);
    setSessErr(null);
    try {
      const result = await client.call<SessionsList>("sessions.list", {});
      setSessions(sessionsFrom(result));
    } catch (e) {
      setSessErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSessLoading(false);
    }
  }, [client, status.kind]);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

  const patch = useCallback(
    async (sessionKey: string, modelId: string) => {
      if (!client || status.kind !== "ready") return;
      setOverride({ kind: "running", sessionKey, modelId });
      try {
        const result = await client.call<PatchResult>("sessions.patch", {
          key: sessionKey,
          model: modelId,
        });
        const resolved = result?.resolvedModel ?? result?.model ?? modelId;
        setApplied((m) => ({ ...m, [sessionKey]: resolved }));
        setOverride({ kind: "ok", sessionKey, modelId: resolved });
      } catch (e) {
        setOverride({
          kind: "error",
          sessionKey,
          modelId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [client, status.kind],
  );

  const activeRow = useMemo(
    () => sessions?.find((s) => sessionKeyOf(s) === activeSession) ?? null,
    [sessions, activeSession],
  );
  const activeModelId = activeSession
    ? applied[activeSession] ?? activeRow?.model
    : undefined;

  return (
    <PageShell
      title="Models"
      subtitle="Every model OpenClaw can route to, by provider"
      actions={
        <>
          <button className="btn-ghost" onClick={() => { void refreshSessions(); }} disabled={sessLoading}>Refresh sessions</button>
          <button className="btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>
        </>
      }
    >
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div className="settings-card-title">Per-session override</div>
        <p className="settings-help" style={{ marginBottom: 8 }}>
          Pick a session to flip its model. The page-default model is whichever entry
          carries the <code>default</code> chip; per-session overrides survive only
          for the chosen session.
        </p>
        {sessErr && <div className="alert error">sessions.list failed: {sessErr}</div>}
        {sessions === null && sessLoading && <div className="spinner" />}
        {sessions !== null && sessions.length === 0 && !sessLoading && (
          <p className="settings-help">No live sessions to override.</p>
        )}
        {sessions !== null && sessions.length > 0 && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label htmlFor="model-session-picker" style={{ fontSize: "0.85rem", color: "var(--muted-foreground)" }}>
              Session:
            </label>
            <select
              id="model-session-picker"
              value={activeSession ?? ""}
              onChange={(e) => setActiveSession(e.target.value || null)}
              style={{ flex: 1, minWidth: 220, maxWidth: 480 }}
            >
              <option value="">— pick a session —</option>
              {sessions.map((s) => {
                const key = sessionKeyOf(s);
                if (!key) return null;
                const current = applied[key] ?? s.model;
                return (
                  <option key={key} value={key}>
                    {s.label ?? key}
                    {current ? `  ·  ${current}` : ""}
                  </option>
                );
              })}
            </select>
          </div>
        )}
        {activeSession && activeModelId && (
          <div className="settings-help" style={{ marginTop: 8 }}>
            Currently routes to <span className="chip">{activeModelId}</span>
          </div>
        )}
        {override.kind === "ok" && override.sessionKey === activeSession && (
          <div className="alert" style={{ marginTop: 8, background: "rgba(58, 160, 90, 0.18)", color: "#6fcf97" }}>
            Switched <code>{override.sessionKey}</code> to <code>{override.modelId}</code>
          </div>
        )}
        {override.kind === "error" && (
          <div className="alert error" style={{ marginTop: 8 }}>
            Patch failed: {override.message}
          </div>
        )}
      </div>

      {loading && <div className="empty"><div className="spinner" />Loading…</div>}
      {error && <div className="alert error">{error}</div>}
      {!loading && !error && models.length === 0 && (
        <div className="empty"><div className="big">🧮</div>No models registered.</div>
      )}
      <div className="mcp-groups">
        {Array.from(grouped.entries()).map(([provider, list]) => (
          <section key={provider} className="mcp-group">
            <header className="mcp-group-header">
              <div className="mcp-group-name">{provider}</div>
              <span className="chip">{list.length}</span>
            </header>
            <ul className="page-list">
              {list.map((m) => {
                const isActive = activeSession ? activeModelId === m.id : false;
                const busy = override.kind === "running" && override.sessionKey === activeSession && override.modelId === m.id;
                return (
                  <li key={m.id} className="page-row">
                    <div className="page-row-main">
                      <div className="page-row-title">{m.label ?? m.id}</div>
                      <div className="page-row-subtitle">
                        <span className="chip">{m.id}</span>
                        {typeof m.contextWindow === "number" && (
                          <span className="chip">{(m.contextWindow / 1000).toFixed(0)}k ctx</span>
                        )}
                        {m.capabilities?.map((c) => <span key={c} className="chip">{c}</span>)}
                      </div>
                    </div>
                    <div className="page-row-meta">
                      {m.isDefault && (
                        <span className="status-pill ok"><span className="status-dot" />default</span>
                      )}
                      {activeSession && (
                        isActive ? (
                          <span className="status-pill ok">
                            <span className="status-dot" />
                            active here
                          </span>
                        ) : (
                          <button
                            className="btn-ghost"
                            disabled={busy || status.kind !== "ready"}
                            onClick={() => void patch(activeSession, m.id)}
                          >
                            {busy ? <span className="spinner" /> : "Use here"}
                          </button>
                        )
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
