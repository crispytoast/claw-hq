import { useCallback, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { usePageRpc } from "./usePageRpc.js";
import { Chat } from "../icons.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
  onOpenSession?(key: string): void;
}

interface Session {
  sessionKey?: string;
  key?: string;
  title?: string;
  label?: string;
  agentId?: string;
  model?: string;
  updatedAt?: number;
  lastActivityMs?: number;
}

interface SessionsList {
  sessions?: Session[];
  entries?: Session[];
  rows?: Session[];
}

/**
 * sessions.list + bulk actions (delete / compact / reset).
 * Action buttons use `sessions.delete` / `sessions.compact` / `sessions.reset`
 * with a confirm dialog before they fire — these are destructive RPCs.
 */
export function SessionsPage({ client, status, onOpenSession }: Props) {
  const { data, loading, error, refresh } = usePageRpc<SessionsList>(client, status, "sessions.list");
  const [busy, setBusy] = useState<string | null>(null);

  const sessions = (data?.sessions ?? data?.entries ?? data?.rows ?? []) as Session[];

  const run = useCallback(async (method: string, key: string, label: string) => {
    if (!client) return;
    if (!window.confirm(`${label} session "${key}"?`)) return;
    setBusy(`${method}:${key}`);
    try {
      await client.call(method, { sessionKey: key });
      refresh();
    } catch (err) {
      window.alert(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [client, refresh]);

  return (
    <PageShell
      title="Sessions"
      subtitle="Every conversation OpenClaw has retained"
      actions={<button className="btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>}
    >
      {loading && <div className="empty"><div className="spinner" />Loading…</div>}
      {error && <div className="alert error">{error}</div>}
      {!loading && !error && sessions.length === 0 && (
        <div className="empty"><div className="big"><Chat size={28} /></div>No sessions.</div>
      )}
      <ul className="page-list">
        {sessions.map((s, i) => {
          const key = s.sessionKey ?? s.key ?? String(i);
          const title = s.title ?? s.label ?? key;
          const ts = s.lastActivityMs ?? s.updatedAt;
          return (
            <li key={key} className="page-row">
              <div className="page-row-main">
                <div className="page-row-title">{title}</div>
                <div className="page-row-subtitle">
                  {s.agentId && <span className="chip">{s.agentId}</span>}
                  {s.model && <span className="chip">{s.model}</span>}
                  {ts && <span>{new Date(ts).toLocaleString()}</span>}
                </div>
              </div>
              <div className="page-row-meta">
                {onOpenSession && (
                  <button className="btn-ghost" onClick={() => onOpenSession(key)}>Open</button>
                )}
                <button
                  className="btn-ghost"
                  disabled={busy === `sessions.compact:${key}`}
                  onClick={() => void run("sessions.compact", key, "Compact")}
                >Compact</button>
                <button
                  className="btn-ghost danger"
                  disabled={busy === `sessions.delete:${key}`}
                  onClick={() => void run("sessions.delete", key, "Delete")}
                >Delete</button>
              </div>
            </li>
          );
        })}
      </ul>
    </PageShell>
  );
}
