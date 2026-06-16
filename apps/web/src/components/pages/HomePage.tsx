import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import type { SidebarPage } from "../Sidebar.js";
import { PageShell } from "./PageShell.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
  onSelectPage(page: SidebarPage): void;
}

interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  blurb: string;
  progress: number;
  lastUpdatedMs: number;
}

interface ChatSummary {
  id: string;
  projectSlug: string | null;
  title: string;
  updatedMs: number;
  messageCount: number;
}

interface MemoryFileSummary {
  name: string;
  updatedMs: number;
}

interface DocSummary {
  relativePath: string;
  updatedMs: number;
}

interface TaskLine {
  projectSlug: string;
  checked: boolean;
}

interface SubprojectSummary {
  parent: string;
  id: string;
  status: "active" | "back-burner" | "done";
}

interface Stats {
  projects: { total: number; loading: boolean; error: string | null };
  subprojects: { active: number; total: number; loading: boolean; error: string | null };
  chats: { total: number; loading: boolean; error: string | null };
  memory: { total: number; loading: boolean; error: string | null };
  docs: { total: number; loading: boolean; error: string | null };
  tasks: { open: number; done: number; loading: boolean; error: string | null };
}

const INITIAL_STATS: Stats = {
  projects: { total: 0, loading: true, error: null },
  subprojects: { active: 0, total: 0, loading: true, error: null },
  chats: { total: 0, loading: true, error: null },
  memory: { total: 0, loading: true, error: null },
  docs: { total: 0, loading: true, error: null },
  tasks: { open: 0, done: 0, loading: true, error: null },
};

interface RecentActivity {
  kind: "chat" | "memory" | "doc";
  label: string;
  sublabel: string;
  ms: number;
  onClick(): void;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function HomePage({ client, status, onSelectPage }: Props) {
  const [stats, setStats] = useState<Stats>(INITIAL_STATS);
  const [recent, setRecent] = useState<RecentActivity[]>([]);

  const loadAll = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    // Fire every probe in parallel — each updates its slice independently so a
    // slow projects.list never holds up the whole dashboard.
    const runProbe = async <T,>(
      key: keyof Stats,
      method: string,
      params: Record<string, unknown>,
      onSuccess: (res: T) => Partial<Stats[keyof Stats]>,
    ) => {
      try {
        const res = await client.call<T>(method, params);
        const patch = onSuccess(res);
        setStats((prev) => ({
          ...prev,
          [key]: { ...prev[key], ...patch, loading: false, error: null },
        }));
      } catch (err) {
        setStats((prev) => ({
          ...prev,
          [key]: {
            ...prev[key],
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    };

    const projectsP = runProbe<{ projects: ProjectSummary[] }>(
      "projects",
      "clawhq.projects.list",
      {},
      (res) => ({ total: res.projects.length }),
    );
    const subprojectsP = runProbe<{ subprojects: SubprojectSummary[] }>(
      "subprojects",
      "clawhq.subprojects.list",
      {},
      (res) => ({
        active: res.subprojects.filter((s) => s.status === "active").length,
        total: res.subprojects.length,
      }),
    );
    const chatsP = runProbe<{ chats: ChatSummary[] }>(
      "chats",
      "clawhq.chats.list",
      {},
      (res) => ({ total: res.chats.length }),
    );
    const memoryP = runProbe<{ files: MemoryFileSummary[] }>(
      "memory",
      "clawhq.memory.list",
      {},
      (res) => ({ total: res.files.length }),
    );
    const docsP = runProbe<{ docs: DocSummary[] }>(
      "docs",
      "clawhq.docs.list",
      {},
      (res) => ({ total: res.docs.length }),
    );
    const tasksP = runProbe<{ tasks: TaskLine[] }>(
      "tasks",
      "clawhq.tasks.listAll",
      {},
      (res) => ({
        open: res.tasks.filter((t) => !t.checked).length,
        done: res.tasks.filter((t) => t.checked).length,
      }),
    );
    // Recent activity uses the same chats list + workspace memory list +
    // docs list to assemble a "newest 5 things in the workspace" rail.
    const recentP = (async () => {
      try {
        const [chats, mem, docs] = await Promise.all([
          client.call<{ chats: ChatSummary[] }>("clawhq.chats.list", {}),
          client.call<{ files: MemoryFileSummary[] }>("clawhq.memory.list", {}),
          client.call<{ docs: DocSummary[] }>("clawhq.docs.list", {}),
        ]);
        const items: RecentActivity[] = [];
        for (const c of chats.chats.slice(0, 8)) {
          items.push({
            kind: "chat",
            label: c.title,
            sublabel: c.projectSlug ?? "no project",
            ms: c.updatedMs,
            onClick: () => onSelectPage("home"), // chats open via sidebar; home → sidebar
          });
        }
        for (const m of mem.files.slice(0, 5)) {
          items.push({
            kind: "memory",
            label: m.name,
            sublabel: "workspace memory",
            ms: m.updatedMs,
            onClick: () => onSelectPage("memory"),
          });
        }
        // Docs are sorted alphabetically by listDocs; sort by mtime for recency.
        const docsByMtime = [...docs.docs].sort((a, b) => b.updatedMs - a.updatedMs).slice(0, 5);
        for (const d of docsByMtime) {
          items.push({
            kind: "doc",
            label: d.relativePath,
            sublabel: "doc",
            ms: d.updatedMs,
            onClick: () => onSelectPage("docs"),
          });
        }
        items.sort((a, b) => b.ms - a.ms);
        setRecent(items.slice(0, 8));
      } catch {
        // Recent rail is a best-effort secondary read — failures get
        // suppressed so they don't drown the more useful tile errors.
      }
    })();

    await Promise.all([projectsP, subprojectsP, chatsP, memoryP, docsP, tasksP, recentP]);
  }, [client, status.kind, onSelectPage]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const tiles = useMemo(
    () => [
      {
        key: "projects",
        label: "Projects",
        icon: "🗂️",
        value: stats.projects.total,
        sub: stats.projects.loading ? "…" : "in workspace",
        error: stats.projects.error,
        onClick: () => {
          // No projects page surface yet — Projects live in the sidebar's
          // Projects group. Land users on subprojects which is the closest
          // page-level view.
          onSelectPage("subprojects");
        },
      },
      {
        key: "subprojects",
        label: "Subprojects",
        icon: "🌿",
        value: stats.subprojects.active,
        sub: stats.subprojects.loading ? "…" : `${stats.subprojects.total} total`,
        error: stats.subprojects.error,
        onClick: () => onSelectPage("subprojects"),
      },
      {
        key: "tasks",
        label: "Open tasks",
        icon: "✅",
        value: stats.tasks.open,
        sub: stats.tasks.loading
          ? "…"
          : `${stats.tasks.done} done`,
        error: stats.tasks.error,
        onClick: () => onSelectPage("tasks"),
      },
      {
        key: "docs",
        label: "Docs",
        icon: "📚",
        value: stats.docs.total,
        sub: stats.docs.loading ? "…" : "markdown files",
        error: stats.docs.error,
        onClick: () => onSelectPage("docs"),
      },
      {
        key: "memory",
        label: "Memory",
        icon: "📅",
        value: stats.memory.total,
        sub: stats.memory.loading ? "…" : "workspace files",
        error: stats.memory.error,
        onClick: () => onSelectPage("memory"),
      },
      {
        key: "chats",
        label: "Chats",
        icon: "💬",
        value: stats.chats.total,
        sub: stats.chats.loading ? "…" : "saved sessions",
        error: stats.chats.error,
        onClick: () => onSelectPage("sessions"),
      },
    ],
    [stats, onSelectPage],
  );

  return (
    <PageShell
      title="Home"
      subtitle="Quick read of everything in the workspace"
      actions={
        <button className="cl-btn" onClick={() => void loadAll()} disabled={status.kind !== "ready"}>
          Refresh
        </button>
      }
    >
      <div className="cl-home-grid">
        {tiles.map((t) => (
          <div
            key={t.key}
            className={`cl-home-tile${t.error ? " is-error" : ""}`}
            onClick={t.onClick}
          >
            <div className="cl-home-tile-icon">{t.icon}</div>
            <div className="cl-home-tile-body">
              <div className="cl-home-tile-value">{t.error ? "—" : t.value}</div>
              <div className="cl-home-tile-label">{t.label}</div>
              <div className="cl-home-tile-sub">{t.error ?? t.sub}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="cl-home-recent">
        <div className="cl-home-section-label">Recent activity</div>
        {recent.length === 0 && (
          <div className="cl-home-recent-empty">No recent activity yet.</div>
        )}
        {recent.map((r, i) => (
          <div
            key={`${r.kind}::${i}::${r.label}`}
            className="cl-home-recent-row"
            onClick={r.onClick}
          >
            <span className="cl-home-recent-kind">{r.kind}</span>
            <span className="cl-home-recent-label">{r.label}</span>
            <span className="cl-home-recent-sub">{r.sublabel}</span>
            <span className="cl-home-recent-time">{formatRelative(r.ms)}</span>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
