import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";
import { PageShell } from "./PageShell.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
  projectSlug: string;
}

interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  blurb: string;
  progress: number;
}

interface SubprojectSummary {
  parent: string;
  id: string;
  name: string;
  blurb: string;
  status: "active" | "back-burner" | "done";
  progress: number;
}

interface ProjectGetResult {
  summary: ProjectSummary;
  docs: { brief: string; roadmap: string; tasks: string; memoryIndex: string };
  subprojects: SubprojectSummary[];
}

// GitHub-style checkbox. Capture pre, state char, post so we can re-render with
// the original prefix preserved (`-` vs `*`, indentation, etc.).
const CHECKBOX_LINE_REGEX = /^(\s*[-*]\s*\[)([ xX])(\]\s)(.*)$/;

interface ParsedTaskLine {
  /** Index among checkbox lines only — the value our toggle RPC takes. */
  checkboxIndex: number;
  checked: boolean;
  label: string;
}

interface ParsedTasksBlock {
  /** Original lines for non-checkbox rendering. */
  lines: string[];
  /** checkbox line idx (in the lines array) -> parsed info. */
  byLineIdx: Map<number, ParsedTaskLine>;
  /** Number of checkbox lines in total. */
  count: number;
}

function parseTasksMarkdown(content: string): ParsedTasksBlock {
  const lines = content.split("\n");
  const byLineIdx = new Map<number, ParsedTaskLine>();
  let checkboxIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_LINE_REGEX.exec(lines[i]!);
    if (!m) continue;
    const checked = m[2] === "x" || m[2] === "X";
    byLineIdx.set(i, { checkboxIndex, checked, label: m[4] ?? "" });
    checkboxIndex++;
  }
  return { lines, byLineIdx, count: checkboxIndex };
}

export function ProjectPage({ client, status, projectSlug }: Props) {
  const [data, setData] = useState<ProjectGetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Per-checkbox in-flight flag so users can't double-toggle. */
  const [pendingToggles, setPendingToggles] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.call<ProjectGetResult>("clawhq.projects.get", {
        slug: projectSlug,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, status.kind, projectSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Cross-device: when any device toggles a task, refresh our tasks content.
  useEffect(() => {
    if (!client) return;
    return client.onEvent((ev: OpenClawEvent) => {
      if (ev.event !== "plugin.clawhq.task.toggled") return;
      const p = (ev.payload ?? {}) as {
        projectSlug?: unknown;
        subprojectSlug?: unknown;
        content?: unknown;
      };
      // Only project-level tasks render on this page (subprojects later).
      if (p.projectSlug !== projectSlug) return;
      if (p.subprojectSlug !== null) return;
      if (typeof p.content !== "string") return;
      setData((prev) => (prev ? { ...prev, docs: { ...prev.docs, tasks: p.content as string } } : prev));
    });
  }, [client, projectSlug]);

  const toggleTask = useCallback(
    async (checkboxIndex: number, next: boolean) => {
      if (!client || status.kind !== "ready") return;
      setPendingToggles((s) => new Set(s).add(checkboxIndex));
      // Optimistic update so the click feels instant.
      setData((prev) => {
        if (!prev) return prev;
        const parsed = parseTasksMarkdown(prev.docs.tasks);
        const newLines = [...parsed.lines];
        for (const [idx, info] of parsed.byLineIdx) {
          if (info.checkboxIndex !== checkboxIndex) continue;
          newLines[idx] = newLines[idx]!.replace(
            CHECKBOX_LINE_REGEX,
            (_, pre, _state, post, label) => `${pre}${next ? "x" : " "}${post}${label}`,
          );
          break;
        }
        return { ...prev, docs: { ...prev.docs, tasks: newLines.join("\n") } };
      });
      try {
        await client.call("clawhq.tasks.toggle", {
          projectSlug,
          lineIndex: checkboxIndex,
          checked: next,
        });
      } catch (err) {
        // Roll back optimistic update + show error.
        setError(err instanceof Error ? err.message : String(err));
        void load();
      } finally {
        setPendingToggles((s) => {
          const nextSet = new Set(s);
          nextSet.delete(checkboxIndex);
          return nextSet;
        });
      }
    },
    [client, status.kind, projectSlug, load],
  );

  const parsedTasks = useMemo<ParsedTasksBlock | null>(() => {
    if (!data?.docs.tasks) return null;
    return parseTasksMarkdown(data.docs.tasks);
  }, [data?.docs.tasks]);

  const taskProgress = useMemo(() => {
    if (!parsedTasks || parsedTasks.count === 0) return null;
    let checked = 0;
    for (const info of parsedTasks.byLineIdx.values()) if (info.checked) checked++;
    return { checked, total: parsedTasks.count, pct: Math.round((checked / parsedTasks.count) * 100) };
  }, [parsedTasks]);

  return (
    <PageShell
      title={data?.summary.name ?? projectSlug}
      subtitle={data?.summary.blurb}
      actions={
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      }
    >
      {loading && !data && <div className="empty"><div className="spinner" />Loading project…</div>}
      {error && <div className="alert error">{error}</div>}
      {data && (
        <div className="project-cards">
          <div className="project-card">
            <div className="project-card-header">
              <h3>BRIEF</h3>
              <span className={`status-pill ${statusPillClass(data.summary.status)}`}>
                <span className="status-dot" />
                {data.summary.status}
              </span>
            </div>
            <pre className="project-card-body">{data.docs.brief.trim() || "(empty)"}</pre>
          </div>

          <div className="project-card">
            <div className="project-card-header">
              <h3>ROADMAP</h3>
              {data.summary.progress > 0 && (
                <span className="cl-row-tag">{data.summary.progress}% complete</span>
              )}
            </div>
            <pre className="project-card-body">{data.docs.roadmap.trim() || "(empty)"}</pre>
          </div>

          <div className="project-card">
            <div className="project-card-header">
              <h3>TASKS</h3>
              {taskProgress && (
                <span className="cl-row-tag">
                  {taskProgress.checked} / {taskProgress.total} done ({taskProgress.pct}%)
                </span>
              )}
            </div>
            <div className="project-card-body project-tasks">
              {parsedTasks ? (
                parsedTasks.lines.map((line, idx) => {
                  const info = parsedTasks.byLineIdx.get(idx);
                  if (info) {
                    const inFlight = pendingToggles.has(info.checkboxIndex);
                    return (
                      <label key={idx} className={`task-line ${info.checked ? "checked" : ""}`}>
                        <input
                          type="checkbox"
                          checked={info.checked}
                          disabled={inFlight}
                          onChange={(e) => void toggleTask(info.checkboxIndex, e.target.checked)}
                        />
                        <span>{info.label}</span>
                      </label>
                    );
                  }
                  // Non-checkbox lines render as plain markdown text (preserve blank lines).
                  return (
                    <div key={idx} className="task-meta-line">
                      {line || " "}
                    </div>
                  );
                })
              ) : (
                <div className="empty">(no TASKS.md)</div>
              )}
            </div>
          </div>

          {data.subprojects.length > 0 && (
            <div className="project-card">
              <div className="project-card-header">
                <h3>SUBPROJECTS</h3>
                <span className="cl-row-tag">{data.subprojects.length}</span>
              </div>
              <ul className="page-list">
                {data.subprojects.map((s) => (
                  <li key={s.id} className="page-row">
                    <div className="page-row-main">
                      <div className="page-row-title">{s.name}</div>
                      {s.blurb && <div className="page-row-subtitle">{s.blurb}</div>}
                    </div>
                    <div className="page-row-meta">
                      <span className={`status-pill ${subprojectStatusClass(s.status)}`}>
                        <span className="status-dot" />
                        {s.status}
                      </span>
                      {s.progress > 0 && <span>{s.progress}%</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

        </div>
      )}
    </PageShell>
  );
}

function statusPillClass(s: string): string {
  const l = s.toLowerCase();
  if (l.includes("live")) return "ok";
  if (l.includes("build") || l.includes("active")) return "warn";
  return "bad";
}

function subprojectStatusClass(s: string): string {
  if (s === "done") return "ok";
  if (s === "active") return "warn";
  return "bad";
}
