import { useCallback, useEffect, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";

interface CronJob {
  id?: string;
  name?: string;
  title?: string;
  schedule?: string;
  cron?: string;
  agentId?: string;
  sessionKey?: string;
  enabled?: boolean;
  nextRunMs?: number;
  lastRunMs?: number;
  description?: string;
  /** Some installs return the prompt/message text under various keys. */
  message?: string;
  prompt?: string;
}

interface CronListResponse {
  jobs: CronJob[];
  total?: number;
  offset?: number;
  limit?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
}

interface CronRun {
  runId?: string;
  jobId?: string;
  status?: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

interface CronRunsResponse {
  runs?: CronRun[];
  jobRuns?: CronRun[];
}

function relativeTime(ms?: number): string {
  if (!ms || ms <= 0) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) {
    // future
    const sec = Math.floor(-diff / 1000);
    if (sec < 60) return `in ${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `in ${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `in ${hr}h`;
    return `in ${Math.floor(hr / 24)}d`;
  }
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function jobLabel(j: CronJob): string {
  return j.title || j.name || j.id || "(unnamed)";
}

function jobSchedule(j: CronJob): string {
  return j.schedule || j.cron || "(no schedule)";
}

function jobPreview(j: CronJob): string | null {
  const text = j.message || j.prompt || j.description;
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 140 ? `${collapsed.slice(0, 137)}…` : collapsed;
}

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

export function CronPage({ client, status }: Props) {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<Map<string, CronRun[]>>(new Map());
  const [pendingActionFor, setPendingActionFor] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setLoading(true);
    setError(null);
    try {
      const res = await client.call<CronListResponse>("cron.list", { limit: 100 });
      setJobs(res.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [client, status.kind]);

  useEffect(() => { void load(); }, [load]);

  const loadRuns = useCallback(
    async (jobId: string) => {
      if (!client || status.kind !== "ready") return;
      try {
        const res = await client.call<CronRunsResponse>("cron.runs", { jobId, limit: 10 });
        const list = res.runs ?? res.jobRuns ?? [];
        setRecentRuns((m) => new Map(m).set(jobId, list));
      } catch (err) {
        setRecentRuns((m) => new Map(m).set(jobId, []));
        console.warn("cron.runs failed:", err);
      }
    },
    [client, status.kind],
  );

  const toggleExpand = (jobId: string) => {
    setExpanded((curr) => {
      const next = curr === jobId ? null : jobId;
      if (next && !recentRuns.has(next)) void loadRuns(next);
      return next;
    });
  };

  const runNow = useCallback(
    async (jobId: string) => {
      if (!client || status.kind !== "ready") return;
      setPendingActionFor(jobId);
      setActionMsg(null);
      try {
        const res = await client.call<{ runId?: string }>("cron.run", { jobId });
        setActionMsg(res.runId ? `Queued runId=${res.runId.slice(0, 12)}…` : "Queued");
        if (expanded === jobId) void loadRuns(jobId);
      } catch (err) {
        setActionMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingActionFor(null);
      }
    },
    [client, status.kind, expanded, loadRuns],
  );

  const remove = useCallback(
    async (jobId: string, label: string) => {
      if (!client || status.kind !== "ready") return;
      const ok = window.confirm(`Delete cron job "${label}"? This can't be undone.`);
      if (!ok) return;
      setPendingActionFor(jobId);
      try {
        await client.call("cron.remove", { jobId });
        setActionMsg(`Removed ${label}`);
        await load();
      } catch (err) {
        setActionMsg(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingActionFor(null);
      }
    },
    [client, status.kind, load],
  );

  return (
    <PageShell
      title="Cron"
      subtitle={`Scheduled Gateway jobs${jobs ? ` · ${jobs.length}` : ""}`}
      actions={
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      }
    >
      {actionMsg && <div className="alert">{actionMsg}</div>}
      {error && <div className="alert error">{error}</div>}
      {loading && jobs === null && (
        <div className="empty"><div className="spinner" />Loading…</div>
      )}
      {jobs && jobs.length === 0 && !loading && !error && (
        <div className="empty">
          <div className="big">⏰</div>
          No cron jobs configured. Use `openclaw cron add` from the CLI to create one;
          this page will pick it up.
        </div>
      )}
      {jobs && jobs.length > 0 && (
        <ul className="page-list">
          {jobs.map((j) => {
            const jobId = j.id ?? jobLabel(j);
            const isExpanded = expanded === jobId;
            const isPending = pendingActionFor === jobId;
            const runs = recentRuns.get(jobId);
            const preview = jobPreview(j);
            return (
              <li key={jobId}>
                <div className="page-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <button
                    type="button"
                    className="page-row-clickable"
                    style={{ display: "flex", alignItems: "center", gap: 12, background: "transparent", border: 0, padding: 0, textAlign: "left", color: "inherit", cursor: "pointer" }}
                    onClick={() => toggleExpand(jobId)}
                  >
                    <span style={{ color: "var(--muted-foreground)", width: 14 }}>{isExpanded ? "▾" : "▸"}</span>
                    <div className="page-row-main">
                      <div className="page-row-title">{jobLabel(j)}</div>
                      <div className="page-row-subtitle" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8rem" }}>
                        {jobSchedule(j)}
                      </div>
                    </div>
                    <div className="page-row-meta">
                      {j.enabled === false && <span className="status-pill bad"><span className="status-dot" />disabled</span>}
                      {j.enabled !== false && <span className="status-pill ok"><span className="status-dot" />enabled</span>}
                      {j.nextRunMs && <span>next {relativeTime(j.nextRunMs)}</span>}
                      {j.lastRunMs && <span>last {relativeTime(j.lastRunMs)}</span>}
                    </div>
                  </button>
                  {isExpanded && (
                    <div style={{ paddingLeft: 26, display: "flex", flexDirection: "column", gap: 8 }}>
                      {preview && (
                        <div style={{ color: "var(--muted-foreground)", fontSize: "0.85rem" }}>
                          {preview}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          className="btn-ghost"
                          onClick={() => void runNow(jobId)}
                          disabled={isPending}
                        >Run now</button>
                        <button
                          className="btn-ghost"
                          onClick={() => void remove(jobId, jobLabel(j))}
                          disabled={isPending}
                        >Remove</button>
                        <button
                          className="btn-ghost"
                          onClick={() => void loadRuns(jobId)}
                        >Refresh runs</button>
                      </div>
                      <div className="cron-runs">
                        {runs === undefined ? (
                          <div className="cl-list-empty">Loading runs…</div>
                        ) : runs.length === 0 ? (
                          <div className="cl-list-empty">No recent runs.</div>
                        ) : (
                          <ul className="page-list" style={{ marginTop: 0 }}>
                            {runs.map((r, idx) => (
                              <li key={r.runId ?? idx}>
                                <div className="page-row">
                                  <div className="page-row-main">
                                    <div className="page-row-title" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.78rem" }}>
                                      {(r.runId ?? `(no id #${idx})`).slice(0, 24)}
                                    </div>
                                    {r.error && (
                                      <div className="page-row-subtitle" style={{ color: "#ff8a8a" }}>{r.error}</div>
                                    )}
                                  </div>
                                  <div className="page-row-meta">
                                    {r.status && <span className="cl-row-tag">{r.status}</span>}
                                    {r.startedAt && <span>{relativeTime(r.startedAt)}</span>}
                                  </div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}
