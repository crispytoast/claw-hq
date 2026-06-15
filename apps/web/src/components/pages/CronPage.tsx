import { useCallback, useEffect, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";

interface CronJobPayload {
  kind?: "systemEvent" | "agentTurn" | string;
  text?: string;
  message?: string;
}

interface CronJob {
  id?: string;
  name?: string;
  title?: string;
  schedule?: string | { kind?: string; expr?: string };
  cron?: string;
  agentId?: string;
  sessionKey?: string;
  sessionTarget?: string;
  session?: string;
  enabled?: boolean;
  nextRunMs?: number;
  lastRunMs?: number;
  description?: string;
  /** Some installs return the prompt/message text under various keys. */
  message?: string;
  prompt?: string;
  /** Modern OpenClaw shape — payload carries the kind + text. */
  payload?: CronJobPayload;
  /** Legacy installs may surface the kind flat. */
  kind?: string;
}

type JobKind = "isolated-agent" | "main-systemEvent";

function detectJobKind(j: CronJob): JobKind {
  const k = j.payload?.kind ?? j.kind;
  const target = j.sessionTarget ?? j.session;
  if (k === "systemEvent" || target === "main") return "main-systemEvent";
  return "isolated-agent";
}

function jobMessageText(j: CronJob): string {
  return j.payload?.text ?? j.payload?.message ?? j.message ?? j.prompt ?? "";
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
  if (typeof j.schedule === "string") return j.schedule;
  if (j.schedule?.expr) return j.schedule.expr;
  return j.cron || "(no schedule)";
}

function jobPreview(j: CronJob): string | null {
  const text = jobMessageText(j) || j.description;
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 140 ? `${collapsed.slice(0, 137)}…` : collapsed;
}

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface EditDraft {
  /** When null, this is a new-job draft. */
  id: string | null;
  name: string;
  cron: string;
  message: string;
  enabled: boolean;
  kind: JobKind;
}

const EMPTY_DRAFT: EditDraft = {
  id: null,
  name: "",
  cron: "",
  message: "",
  enabled: true,
  kind: "isolated-agent",
};

function buildAddParams(d: EditDraft): Record<string, unknown> {
  if (d.kind === "main-systemEvent") {
    // Main-session systemEvent jobs need the structured schema —
    // OpenClaw's legacy normalizer rejects flat `{session:"main", kind:"systemEvent"}`
    // with "main cron jobs require payload.kind=\"systemEvent\"". Confirmed by
    // the C36 wire probe.
    return {
      name: d.name,
      enabled: d.enabled,
      schedule: { kind: "cron", expr: d.cron },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: d.message },
    };
  }
  // Isolated agent-turn jobs accept the flat shape via the legacy normalizer
  // (C21 confirmed). Keep it as-is so existing installs aren't disrupted.
  return {
    name: d.name,
    cron: d.cron,
    session: "isolated",
    message: d.message,
    kind: "message",
    enabled: d.enabled,
  };
}

function buildUpdateParams(d: EditDraft): Record<string, unknown> {
  if (!d.id) throw new Error("update requires id");
  // `{jobId, patch: {...}}` — flat patch fields work for isolated agentTurn
  // jobs (C21). systemEvent jobs need a structured payload patch so the text
  // ends up on payload.text, not the legacy flat `message`.
  const patch: Record<string, unknown> =
    d.kind === "main-systemEvent"
      ? {
          name: d.name,
          schedule: { kind: "cron", expr: d.cron },
          enabled: d.enabled,
          payload: { kind: "systemEvent", text: d.message },
        }
      : {
          name: d.name,
          cron: d.cron,
          message: d.message,
          enabled: d.enabled,
        };
  return { jobId: d.id, patch };
}

export function CronPage({ client, status }: Props) {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<Map<string, CronRun[]>>(new Map());
  const [pendingActionFor, setPendingActionFor] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

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

  const startNew = useCallback(() => {
    setEditing({ ...EMPTY_DRAFT });
    setEditErr(null);
  }, []);

  const startEdit = useCallback((j: CronJob) => {
    const id = j.id ?? null;
    if (!id) return;
    setEditing({
      id,
      name: j.title || j.name || "",
      cron: jobSchedule(j) === "(no schedule)" ? "" : jobSchedule(j),
      message: jobMessageText(j),
      enabled: j.enabled !== false,
      kind: detectJobKind(j),
    });
    setEditErr(null);
  }, []);

  const saveDraft = useCallback(async () => {
    if (!client || status.kind !== "ready" || !editing) return;
    const d = editing;
    if (!d.name.trim() || !d.cron.trim() || !d.message.trim()) {
      setEditErr("name, cron expression, and message are all required");
      return;
    }
    setSaving(true);
    setEditErr(null);
    try {
      if (d.id) {
        await client.call("cron.update", buildUpdateParams(d));
        setActionMsg(`Updated ${d.name}`);
      } else {
        await client.call("cron.add", buildAddParams(d));
        setActionMsg(`Created ${d.name}`);
      }
      setEditing(null);
      await load();
    } catch (err) {
      setEditErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [client, status.kind, editing, load]);

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
        <>
          <button className="btn-primary" onClick={startNew} disabled={editing !== null || loading}>
            + New job
          </button>
          <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </>
      }
    >
      {editing && (
        <div className="cron-edit-card">
          <div className="cron-edit-title">{editing.id ? "Edit job" : "New cron job"}</div>
          <div className="cron-edit-fields">
            <label>
              <span>Name</span>
              <input
                type="text"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Morning brief"
                disabled={saving}
                autoFocus
              />
            </label>
            <label>
              <span>Job type</span>
              <select
                value={editing.kind}
                onChange={(e) =>
                  setEditing({ ...editing, kind: e.target.value as JobKind })
                }
                // Switching kind on an existing job would change the wire shape
                // mid-life. Keep that out of v1.
                disabled={saving || editing.id != null}
              >
                <option value="isolated-agent">Isolated session — agent prompt</option>
                <option value="main-systemEvent">Main session — systemEvent text</option>
              </select>
            </label>
            <label>
              <span>Cron expression</span>
              <input
                type="text"
                value={editing.cron}
                onChange={(e) => setEditing({ ...editing, cron: e.target.value })}
                placeholder="0 7 * * *"
                disabled={saving}
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
              />
            </label>
            <label>
              <span>
                {editing.kind === "main-systemEvent" ? "Event text" : "Message / prompt"}
              </span>
              <textarea
                value={editing.message}
                onChange={(e) => setEditing({ ...editing, message: e.target.value })}
                placeholder={
                  editing.kind === "main-systemEvent"
                    ? "Heartbeat: check overnight diffs."
                    : "Summarize overnight updates."
                }
                rows={3}
                disabled={saving}
              />
            </label>
            <label className="cron-edit-check">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                disabled={saving}
              />
              <span>Enabled</span>
            </label>
          </div>
          <p className="cron-edit-note">
            {editing.kind === "main-systemEvent"
              ? "Injects a systemEvent into your main agent session at the scheduled time. Use for heartbeat-style nudges that should appear inline in the running chat."
              : "Runs in a fresh isolated session each tick — clean transcript, no main-session context."}
          </p>
          {editErr && <div className="alert error">{editErr}</div>}
          <div className="cron-edit-actions">
            <button
              className="btn-primary"
              onClick={() => void saveDraft()}
              disabled={saving}
            >
              {saving ? <span className="spinner" /> : editing.id ? "Save" : "Create"}
            </button>
            <button
              className="btn-ghost"
              onClick={() => { setEditing(null); setEditErr(null); }}
              disabled={saving}
            >Cancel</button>
          </div>
        </div>
      )}
      {actionMsg && <div className="alert">{actionMsg}</div>}
      {error && <div className="alert error">{error}</div>}
      {loading && jobs === null && (
        <div className="empty"><div className="spinner" />Loading…</div>
      )}
      {jobs && jobs.length === 0 && !loading && !error && !editing && (
        <div className="empty">
          <div className="big">⏰</div>
          No cron jobs configured. Tap <strong>+ New job</strong> above to create one,
          or use <code>openclaw cron add</code> from the CLI.
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
                      <span className="cl-row-tag">
                        {detectJobKind(j) === "main-systemEvent" ? "main · event" : "isolated"}
                      </span>
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
                          onClick={() => startEdit(j)}
                          disabled={isPending}
                        >Edit</button>
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
