import { useCallback, useEffect, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";

interface SubprojectRow {
  parent: string;
  id: string;
  name: string;
  blurb: string;
  status: "active" | "back-burner" | "done";
  progress: number;
  lastUpdatedMs: number;
}

interface ListResponse {
  subprojects: SubprojectRow[];
  workspaceRoot: string | null;
  hint?: string;
}

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
  onOpen(parentSlug: string, subSlug: string): void;
}

function subprojectStatusClass(s: SubprojectRow["status"]): string {
  if (s === "done") return "ok";
  if (s === "active") return "warn";
  return "bad";
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.max(0, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function SubprojectsPage({ client, status, onOpen }: Props) {
  const [rows, setRows] = useState<SubprojectRow[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active" | "back-burner" | "done">("all");

  const load = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setLoading(true);
    setError(null);
    try {
      const res = await client.call<ListResponse>("clawhq.subprojects.list", {});
      setRows(res.subprojects);
      setHint(res.hint ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [client, status.kind]);

  useEffect(() => { void load(); }, [load]);

  const filtered = rows?.filter((r) => filter === "all" || r.status === filter) ?? [];

  return (
    <PageShell
      title="Subprojects"
      subtitle={`Every subproject across every project${rows ? ` · ${rows.length} total` : ""}`}
      actions={
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      }
    >
      <div className="cl-filter-chips" style={{ marginBottom: 8 }}>
        {(["all", "active", "back-burner", "done"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`cl-filter-chip ${filter === f ? "cl-active" : ""}`}
            onClick={() => setFilter(f)}
          >{f}</button>
        ))}
      </div>
      {loading && rows === null && (
        <div className="empty"><div className="spinner" />Loading…</div>
      )}
      {error && <div className="alert error">{error}</div>}
      {hint && !error && <div className="cl-list-empty">{hint}</div>}
      {rows && filtered.length === 0 && !loading && !error && (
        <div className="cl-list-empty">No subprojects match this filter.</div>
      )}
      {filtered.length > 0 && (
        <ul className="page-list">
          {filtered.map((s) => (
            <li key={`${s.parent}/${s.id}`}>
              <button
                type="button"
                className="page-row page-row-clickable"
                onClick={() => onOpen(s.parent, s.id)}
              >
                <div className="page-row-main">
                  <div className="page-row-title">
                    <span className="cl-row-tag" style={{ marginRight: 8 }}>{s.parent}</span>
                    {s.name}
                  </div>
                  {s.blurb && <div className="page-row-subtitle">{s.blurb}</div>}
                </div>
                <div className="page-row-meta">
                  <span className={`status-pill ${subprojectStatusClass(s.status)}`}>
                    <span className="status-dot" />
                    {s.status}
                  </span>
                  {s.progress > 0 && <span>{s.progress}%</span>}
                  <span>{relativeTime(s.lastUpdatedMs)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
