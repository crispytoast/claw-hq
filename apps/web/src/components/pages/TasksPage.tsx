import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface TaskLine {
  projectSlug: string;
  projectName: string;
  subprojectSlug: string | null;
  subprojectName: string | null;
  lineIndex: number;
  text: string;
  checked: boolean;
}

interface RollupResponse {
  tasks: TaskLine[];
  projectsScanned: number;
  filesRead: number;
}

interface ToggleResponse {
  projectSlug: string;
  subprojectSlug: string | null;
  lineIndex: number;
  checked: boolean;
  content: string;
  totalCount: number;
  checkedCount: number;
}

type Filter = "open" | "done" | "all";

interface ProjectGroup {
  projectSlug: string;
  projectName: string;
  files: FileGroup[];
}

interface FileGroup {
  subprojectSlug: string | null;
  subprojectName: string | null;
  tasks: TaskLine[];
}

function groupTasks(tasks: TaskLine[]): ProjectGroup[] {
  const byProject = new Map<string, ProjectGroup>();
  for (const t of tasks) {
    let project = byProject.get(t.projectSlug);
    if (!project) {
      project = {
        projectSlug: t.projectSlug,
        projectName: t.projectName,
        files: [],
      };
      byProject.set(t.projectSlug, project);
    }
    const fileKey = t.subprojectSlug ?? "__root__";
    let file = project.files.find((f) => (f.subprojectSlug ?? "__root__") === fileKey);
    if (!file) {
      file = {
        subprojectSlug: t.subprojectSlug,
        subprojectName: t.subprojectName,
        tasks: [],
      };
      project.files.push(file);
    }
    file.tasks.push(t);
  }
  // Stable sort: alphabetical project, project-root first inside each project,
  // alphabetical subprojects after.
  const groups = Array.from(byProject.values());
  groups.sort((a, b) => a.projectName.localeCompare(b.projectName));
  for (const p of groups) {
    p.files.sort((a, b) => {
      if (a.subprojectSlug === null) return -1;
      if (b.subprojectSlug === null) return 1;
      return (a.subprojectName ?? "").localeCompare(b.subprojectName ?? "");
    });
  }
  return groups;
}

function matchesFilter(t: TaskLine, filter: Filter, query: string): boolean {
  if (filter === "open" && t.checked) return false;
  if (filter === "done" && !t.checked) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    t.text.toLowerCase().includes(q) ||
    t.projectName.toLowerCase().includes(q) ||
    (t.subprojectName ?? "").toLowerCase().includes(q)
  );
}

export function TasksPage({ client, status }: Props) {
  const [tasks, setTasks] = useState<TaskLine[] | null>(null);
  const [meta, setMeta] = useState<{ projectsScanned: number; filesRead: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  // Track per-line toggle in-flight + last-known check state so the row flips
  // optimistically even if the broadcast event isn't subscribed yet.
  const [pending, setPending] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setError(null);
    try {
      const res = await client.call<RollupResponse>("clawhq.tasks.listAll", {});
      setTasks(res.tasks);
      setMeta({ projectsScanned: res.projectsScanned, filesRead: res.filesRead });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTasks([]);
    }
  }, [client, status.kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const taskKey = useCallback(
    (t: TaskLine) =>
      `${t.projectSlug}::${t.subprojectSlug ?? "__root__"}::${t.lineIndex}`,
    [],
  );

  const onToggle = useCallback(
    async (t: TaskLine) => {
      if (!client || status.kind !== "ready") return;
      const key = taskKey(t);
      // Optimistic flip — invert in local state, mark in-flight to disable.
      setPending((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setTasks((prev) =>
        prev
          ? prev.map((x) =>
              x.projectSlug === t.projectSlug &&
              x.subprojectSlug === t.subprojectSlug &&
              x.lineIndex === t.lineIndex
                ? { ...x, checked: !x.checked }
                : x,
            )
          : prev,
      );
      try {
        await client.call<ToggleResponse>("clawhq.tasks.toggle", {
          projectSlug: t.projectSlug,
          subprojectSlug: t.subprojectSlug ?? undefined,
          lineIndex: t.lineIndex,
          checked: !t.checked,
        });
      } catch (err) {
        // Revert optimistic flip.
        setTasks((prev) =>
          prev
            ? prev.map((x) =>
                x.projectSlug === t.projectSlug &&
                x.subprojectSlug === t.subprojectSlug &&
                x.lineIndex === t.lineIndex
                  ? { ...x, checked: t.checked }
                  : x,
              )
            : prev,
        );
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [client, status.kind, taskKey],
  );

  const visibleTasks = useMemo(
    () => (tasks ?? []).filter((t) => matchesFilter(t, filter, query.trim())),
    [tasks, filter, query],
  );
  const groups = useMemo(() => groupTasks(visibleTasks), [visibleTasks]);

  const totals = useMemo(() => {
    const all = tasks ?? [];
    return {
      total: all.length,
      open: all.filter((t) => !t.checked).length,
      done: all.filter((t) => t.checked).length,
    };
  }, [tasks]);

  return (
    <PageShell
      title="Tasks"
      subtitle={
        meta
          ? `${totals.open} open · ${totals.done} done across ${meta.filesRead} TASKS.md files in ${meta.projectsScanned} projects`
          : "Aggregated checkboxes across every project + sub-project"
      }
      actions={
        <button className="cl-btn" onClick={() => void load()} disabled={status.kind !== "ready"}>
          Refresh
        </button>
      }
    >
      <div className="cl-tasks-controls">
        <div className="cl-tasks-filter">
          <button
            className={`cl-tasks-tab${filter === "open" ? " is-active" : ""}`}
            onClick={() => setFilter("open")}
          >
            Open ({totals.open})
          </button>
          <button
            className={`cl-tasks-tab${filter === "done" ? " is-active" : ""}`}
            onClick={() => setFilter("done")}
          >
            Done ({totals.done})
          </button>
          <button
            className={`cl-tasks-tab${filter === "all" ? " is-active" : ""}`}
            onClick={() => setFilter("all")}
          >
            All ({totals.total})
          </button>
        </div>
        <input
          type="search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="cl-tasks-search-input"
        />
      </div>
      {error && <div className="cl-tasks-error">{error}</div>}
      <div className="cl-tasks-body">
        {tasks === null && <div className="cl-tasks-empty">Loading…</div>}
        {tasks !== null && groups.length === 0 && (
          <div className="cl-tasks-empty">
            {query
              ? `No tasks match “${query}”.`
              : filter === "open"
                ? "Nothing open. Nice work."
                : filter === "done"
                  ? "Nothing checked off yet."
                  : "No tasks found in any project."}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.projectSlug} className="cl-tasks-project">
            <div className="cl-tasks-project-label">{g.projectName}</div>
            {g.files.map((f) => (
              <div
                key={`${g.projectSlug}::${f.subprojectSlug ?? "__root__"}`}
                className="cl-tasks-file"
              >
                {f.subprojectSlug ? (
                  <div className="cl-tasks-file-label">↳ {f.subprojectName}</div>
                ) : (
                  <div className="cl-tasks-file-label">(project root)</div>
                )}
                {f.tasks.map((t) => {
                  const key = taskKey(t);
                  const inFlight = pending.has(key);
                  return (
                    <label key={key} className={`cl-tasks-row${t.checked ? " is-checked" : ""}`}>
                      <input
                        type="checkbox"
                        checked={t.checked}
                        disabled={inFlight}
                        onChange={() => void onToggle(t)}
                      />
                      <span className="cl-tasks-row-text">{t.text}</span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    </PageShell>
  );
}
