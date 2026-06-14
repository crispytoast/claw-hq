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

interface SubprojectGetResult {
  summary: SubprojectSummary;
  docs: { brief: string; roadmap: string; tasks: string };
}

/** Normalized shape shared between project + subproject rendering. */
interface View {
  kind: "project" | "subproject";
  name: string;
  blurb: string;
  statusLabel: string;
  statusClass: string;
  progress: number;
  briefMd: string;
  roadmapMd: string;
  tasksMd: string;
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

function projectStatusClass(s: string): string {
  const l = s.toLowerCase();
  if (l.includes("live")) return "ok";
  if (l.includes("build") || l.includes("active")) return "warn";
  return "bad";
}

function subprojectStatusClass(s: SubprojectSummary["status"]): string {
  if (s === "done") return "ok";
  if (s === "active") return "warn";
  return "bad";
}

export function ProjectPage({ client, status, projectSlug }: Props) {
  const [activeSub, setActiveSub] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Per-checkbox in-flight flag so users can't double-toggle. */
  const [pendingToggles, setPendingToggles] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setLoading(true);
    setError(null);
    try {
      if (activeSub) {
        const result = await client.call<SubprojectGetResult>(
          "clawhq.subprojects.get",
          { projectSlug, subSlug: activeSub },
        );
        setView({
          kind: "subproject",
          name: result.summary.name,
          blurb: result.summary.blurb,
          statusLabel: result.summary.status,
          statusClass: subprojectStatusClass(result.summary.status),
          progress: result.summary.progress,
          briefMd: result.docs.brief,
          roadmapMd: result.docs.roadmap,
          tasksMd: result.docs.tasks,
          subprojects: [],
        });
      } else {
        const result = await client.call<ProjectGetResult>(
          "clawhq.projects.get",
          { slug: projectSlug },
        );
        setView({
          kind: "project",
          name: result.summary.name,
          blurb: result.summary.blurb,
          statusLabel: result.summary.status,
          statusClass: projectStatusClass(result.summary.status),
          progress: result.summary.progress,
          briefMd: result.docs.brief,
          roadmapMd: result.docs.roadmap,
          tasksMd: result.docs.tasks,
          subprojects: result.subprojects,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, status.kind, projectSlug, activeSub]);

  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  // Cross-device: when any device toggles a task, refresh the matching TASKS.md.
  useEffect(() => {
    if (!client) return;
    return client.onEvent((ev: OpenClawEvent) => {
      if (ev.event !== "plugin.clawhq.task.toggled") return;
      const p = (ev.payload ?? {}) as {
        projectSlug?: unknown;
        subprojectSlug?: unknown;
        content?: unknown;
      };
      if (p.projectSlug !== projectSlug) return;
      const matchesView =
        activeSub === null ? p.subprojectSlug === null : p.subprojectSlug === activeSub;
      if (!matchesView) return;
      if (typeof p.content !== "string") return;
      setView((prev) => (prev ? { ...prev, tasksMd: p.content as string } : prev));
    });
  }, [client, projectSlug, activeSub]);

  const toggleTask = useCallback(
    async (checkboxIndex: number, next: boolean) => {
      if (!client || status.kind !== "ready") return;
      setPendingToggles((s) => new Set(s).add(checkboxIndex));
      // Optimistic update so the click feels instant.
      setView((prev) => {
        if (!prev) return prev;
        const parsed = parseTasksMarkdown(prev.tasksMd);
        const newLines = [...parsed.lines];
        for (const [idx, info] of parsed.byLineIdx) {
          if (info.checkboxIndex !== checkboxIndex) continue;
          newLines[idx] = newLines[idx]!.replace(
            CHECKBOX_LINE_REGEX,
            (_, pre, _state, post, label) => `${pre}${next ? "x" : " "}${post}${label}`,
          );
          break;
        }
        return { ...prev, tasksMd: newLines.join("\n") };
      });
      try {
        await client.call("clawhq.tasks.toggle", {
          projectSlug,
          subprojectSlug: activeSub ?? undefined,
          lineIndex: checkboxIndex,
          checked: next,
        });
      } catch (err) {
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
    [client, status.kind, projectSlug, activeSub, load],
  );

  const parsedTasks = useMemo<ParsedTasksBlock | null>(() => {
    if (!view?.tasksMd) return null;
    return parseTasksMarkdown(view.tasksMd);
  }, [view?.tasksMd]);

  const taskProgress = useMemo(() => {
    if (!parsedTasks || parsedTasks.count === 0) return null;
    let checked = 0;
    for (const info of parsedTasks.byLineIdx.values()) if (info.checked) checked++;
    return { checked, total: parsedTasks.count, pct: Math.round((checked / parsedTasks.count) * 100) };
  }, [parsedTasks]);

  const title = view?.name ?? (activeSub ? `${projectSlug} / ${activeSub}` : projectSlug);
  const subtitle = view?.blurb;

  return (
    <PageShell
      title={title}
      subtitle={subtitle}
      actions={
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      }
    >
      {activeSub && (
        <div className="project-breadcrumb">
          <button className="btn-ghost" onClick={() => setActiveSub(null)}>
            ← {projectSlug}
          </button>
          <span className="project-breadcrumb-sep">/</span>
          <span>{view?.name ?? activeSub}</span>
        </div>
      )}
      {loading && !view && <div className="empty"><div className="spinner" />Loading…</div>}
      {error && <div className="alert error">{error}</div>}
      {view && (
        <div className="project-cards">
          <div className="project-card">
            <div className="project-card-header">
              <h3>BRIEF</h3>
              <span className={`status-pill ${view.statusClass}`}>
                <span className="status-dot" />
                {view.statusLabel}
              </span>
            </div>
            <pre className="project-card-body">{view.briefMd.trim() || "(empty)"}</pre>
          </div>

          <div className="project-card">
            <div className="project-card-header">
              <h3>ROADMAP</h3>
              {view.progress > 0 && (
                <span className="cl-row-tag">{view.progress}% complete</span>
              )}
            </div>
            <pre className="project-card-body">{view.roadmapMd.trim() || "(empty)"}</pre>
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
                  return (
                    <div key={idx} className="task-meta-line">
                      {line || " "}
                    </div>
                  );
                })
              ) : (
                <div className="empty">(no TASKS.md)</div>
              )}
            </div>
          </div>

          {view.kind === "project" && view.subprojects.length > 0 && (
            <div className="project-card">
              <div className="project-card-header">
                <h3>SUBPROJECTS</h3>
                <span className="cl-row-tag">{view.subprojects.length}</span>
              </div>
              <ul className="page-list">
                {view.subprojects.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="page-row page-row-clickable"
                      onClick={() => setActiveSub(s.id)}
                    >
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
                    </button>
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
