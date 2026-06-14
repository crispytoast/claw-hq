import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionSummary } from "./ChatApp.js";
import type { User } from "../api.js";
import type { GatewayClient, ConnectionStatus } from "../gateway.js";

export type SidebarPage =
  | "chat"
  | "sessions"
  | "channels"
  | "mcps"
  | "skills"
  | "models"
  | "approvals"
  | "doctor"
  | "rpc"
  | "settings";

interface NavItem {
  id: Exclude<SidebarPage, "chat">;
  label: string;
  icon: string;
  dot?: "amber" | "green";
}

// Order mirrors OHQ's static nav: live surfaces first, ops/debug last,
// Settings always at the bottom. "Sessions" lives in the expandable group above.
const STATIC_NAV: NavItem[] = [
  { id: "channels",  label: "Channels",  icon: "📡" },
  { id: "mcps",      label: "MCPs",      icon: "🛠️" },
  { id: "skills",    label: "Skills",    icon: "🧠" },
  { id: "models",    label: "Models",    icon: "🧮" },
  { id: "approvals", label: "Approvals", icon: "✋" },
  { id: "doctor",    label: "Doctor",    icon: "🩺" },
  { id: "rpc",       label: "RPC",       icon: "🔌" },
  { id: "settings",  label: "Settings",  icon: "⚙️" },
];

interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  blurb: string;
  progress: number;
  lastUpdatedMs: number;
}

interface ProjectsListResponse {
  projects: ProjectSummary[];
  workspaceRoot: string | null;
  hint?: string;
}

interface ChatSummary {
  id: string;
  projectSlug: string | null;
  title: string;
  createdMs: number;
  updatedMs: number;
  messageCount: number;
}

interface ChatsListResponse {
  chats: ChatSummary[];
}

interface ChatCreateResponse {
  chat: ChatSummary;
}

interface Props {
  user: User;
  page: SidebarPage;
  onSelectPage(page: SidebarPage): void;
  sessions: SessionSummary[];
  activeSessionKey: string | null;
  onPickSession(key: string): void;
  mobileOpen: boolean;
  onMobileClose(): void;
  onLogout(): void | Promise<void>;
  onShowPairedDevices?(): void | Promise<void>;
  footerRight?: React.ReactNode;
  client: GatewayClient | null;
  status: ConnectionStatus;
}

export function Sidebar({
  user,
  page,
  onSelectPage,
  sessions,
  activeSessionKey,
  onPickSession,
  mobileOpen,
  onMobileClose,
  onLogout,
  onShowPairedDevices,
  footerRight,
  client,
  status,
}: Props) {
  // OHQ pattern: the group that matches the current page starts expanded.
  const [sessionsOpen, setSessionsOpen] = useState(page === "chat" || page === "sessions");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | string>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsErr, setProjectsErr] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [projectChats, setProjectChats] = useState<Map<string, ChatSummary[]>>(new Map());
  const [projectChatsLoading, setProjectChatsLoading] = useState<Set<string>>(new Set());
  const [projectChatsErr, setProjectChatsErr] = useState<Map<string, string>>(new Map());

  const loadProjects = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setProjectsLoading(true);
    setProjectsErr(null);
    try {
      const data = await client.call<ProjectsListResponse>(
        "clawhq.projects.list",
        {},
      );
      setProjects(data.projects ?? []);
      if (data.hint) setProjectsErr(data.hint);
    } catch (err) {
      setProjectsErr(err instanceof Error ? err.message : String(err));
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, [client, status.kind]);

  // Lazy: fetch on first expand. Re-fetch on subsequent expands so the list
  // stays fresh after Phase B step N writes (chat append, task toggle, etc.).
  useEffect(() => {
    if (!projectsOpen) return;
    void loadProjects();
  }, [projectsOpen, loadProjects]);

  const loadProjectChats = useCallback(
    async (projectId: string) => {
      if (!client || status.kind !== "ready") return;
      setProjectChatsLoading((s) => new Set(s).add(projectId));
      setProjectChatsErr((m) => {
        const next = new Map(m);
        next.delete(projectId);
        return next;
      });
      try {
        const data = await client.call<ChatsListResponse>(
          "clawhq.chats.list",
          { projectSlug: projectId },
        );
        setProjectChats((m) => new Map(m).set(projectId, data.chats ?? []));
      } catch (err) {
        setProjectChatsErr((m) =>
          new Map(m).set(projectId, err instanceof Error ? err.message : String(err)),
        );
      } finally {
        setProjectChatsLoading((s) => {
          const next = new Set(s);
          next.delete(projectId);
          return next;
        });
      }
    },
    [client, status.kind],
  );

  function toggleProject(projectId: string) {
    setExpandedProjects((s) => {
      const next = new Set(s);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
        if (!projectChats.has(projectId)) void loadProjectChats(projectId);
      }
      return next;
    });
  }

  async function createProjectChat(projectId: string) {
    if (!client || status.kind !== "ready") return;
    try {
      const data = await client.call<ChatCreateResponse>(
        "clawhq.chats.create",
        { projectSlug: projectId, title: "New chat" },
      );
      setProjectChats((m) => {
        const existing = m.get(projectId) ?? [];
        return new Map(m).set(projectId, [data.chat, ...existing]);
      });
    } catch (err) {
      setProjectChatsErr((m) =>
        new Map(m).set(projectId, err instanceof Error ? err.message : String(err)),
      );
    }
  }

  useEffect(() => {
    if (page === "chat" || page === "sessions") setSessionsOpen(true);
  }, [page]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = () => setMenuOpen(false);
    window.addEventListener("click", onDocClick);
    return () => window.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  // Filter is by agent id parsed from the sessionKey (agent:<id>:<tail>). For
  // Phase A this is purely informational — we surface the same set of chips
  // OHQ shows for projects.
  const agentIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.agentId) { set.add(s.agentId); continue; }
      const parts = s.sessionKey.split(":");
      if (parts[0] === "agent" && parts[1]) set.add(parts[1]);
    }
    return [...set].sort();
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    if (filter === "all") return sessions;
    return sessions.filter((s) => {
      const id = s.agentId ?? s.sessionKey.split(":")[1];
      return id === filter;
    });
  }, [sessions, filter]);

  function pick(p: SidebarPage) {
    onSelectPage(p);
    onMobileClose();
  }

  return (
    <>
      <aside className={`cl-sidebar ${mobileOpen ? "cl-open" : ""}`}>
        <div className="cl-sidebar-header" style={{ position: "relative" }}>
          <span className="brand-dot" />
          <span className="cl-sidebar-brand">Claw HQ</span>
          <button
            type="button"
            className="menu"
            aria-label="More"
            style={{ marginLeft: "auto", color: "var(--muted-foreground)", padding: "2px 8px", fontSize: "1.1rem" }}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          >⋯</button>
          {menuOpen && (
            <div className="menu-popover" style={{ top: 48, right: 12, left: "auto" }}>
              {onShowPairedDevices && (
                <button onClick={() => { setMenuOpen(false); void onShowPairedDevices(); }}>
                  Paired devices
                </button>
              )}
              {onShowPairedDevices && <div className="sep" />}
              <button onClick={() => { setMenuOpen(false); void onLogout(); }}>
                Log out ({user.displayName})
              </button>
            </div>
          )}
        </div>

        <nav className="cl-sidebar-nav" aria-label="primary">
          {/* Sessions — expandable. Mirrors OHQ's Chat group. */}
          <div className="cl-sidebar-group">
            <button
              type="button"
              className={`cl-group-header ${page === "chat" || page === "sessions" ? "cl-active" : ""}`}
              onClick={() => setSessionsOpen((v) => !v)}
              aria-expanded={sessionsOpen}
            >
              <span className="cl-group-icon">💬</span>
              <span>Sessions</span>
              <span className="cl-group-chevron">{sessionsOpen ? "▾" : "▸"}</span>
            </button>

            <div className={`cl-group-body ${sessionsOpen ? "cl-expanded" : ""}`}>
              <div className="cl-group-inner">
                <button
                  type="button"
                  className="cl-new-btn"
                  onClick={() => pick("sessions")}
                  title="Browse all sessions"
                >
                  <span>＋</span>
                  <span>All sessions</span>
                </button>

                {agentIds.length > 1 && (
                  <div className="cl-filter-chips">
                    <button
                      type="button"
                      className={`cl-filter-chip ${filter === "all" ? "cl-active" : ""}`}
                      onClick={() => setFilter("all")}
                    >
                      All
                    </button>
                    {agentIds.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className={`cl-filter-chip ${filter === id ? "cl-active" : ""}`}
                        onClick={() => setFilter(id)}
                      >
                        {id}
                      </button>
                    ))}
                  </div>
                )}

                {filteredSessions.length > 0 && (
                  <div className="cl-section-label">Recent</div>
                )}

                <div className="cl-list">
                  {filteredSessions.length === 0 ? (
                    <div className="cl-list-empty">
                      {sessions.length === 0 ? "No sessions yet." : "No sessions match this filter."}
                    </div>
                  ) : (
                    filteredSessions.map((s) => {
                      const isActive = page === "chat" && s.sessionKey === activeSessionKey;
                      const agent = s.agentId ?? s.sessionKey.split(":")[1] ?? null;
                      return (
                        <button
                          key={s.sessionKey}
                          type="button"
                          className={`cl-row ${isActive ? "cl-active" : ""}`}
                          onClick={() => {
                            onPickSession(s.sessionKey);
                            onMobileClose();
                          }}
                        >
                          <div className="cl-row-main">
                            <span className="cl-row-title">{s.label}</span>
                          </div>
                          <div className="cl-row-meta">
                            {agent && (
                              <>
                                <span className="cl-row-tag">{agent}</span>
                                <span>·</span>
                              </>
                            )}
                            <span>{s.lastActivityMs ? relativeTime(s.lastActivityMs) : "—"}</span>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Projects — placeholder for Phase C (workspace cards). */}
          <div className="cl-sidebar-group">
            <button
              type="button"
              className="cl-group-header"
              onClick={() => setProjectsOpen((v) => !v)}
              aria-expanded={projectsOpen}
            >
              <span className="cl-group-icon">📁</span>
              <span>Projects</span>
              <span className="cl-group-chevron">{projectsOpen ? "▾" : "▸"}</span>
            </button>
            <div className={`cl-group-body ${projectsOpen ? "cl-expanded" : ""}`}>
              <div className="cl-group-inner">
                {projectsLoading && projects === null ? (
                  <div className="cl-list-empty">Loading projects…</div>
                ) : projects && projects.length > 0 ? (
                  <div className="cl-list">
                    {projects.map((p) => {
                      const isExpanded = expandedProjects.has(p.id);
                      const chats = projectChats.get(p.id);
                      const chatsLoading = projectChatsLoading.has(p.id);
                      const chatsErr = projectChatsErr.get(p.id);
                      return (
                        <div key={p.id} className="cl-project-block">
                          <button
                            type="button"
                            className="cl-row"
                            title={p.blurb || p.name}
                            onClick={() => toggleProject(p.id)}
                          >
                            <div className="cl-row-main">
                              <span className="cl-row-title">
                                <span className="cl-project-chevron">{isExpanded ? "▾" : "▸"}</span>
                                {p.name}
                              </span>
                            </div>
                            <div className="cl-row-meta">
                              <span className={`cl-row-tag cl-status-${p.status.toLowerCase()}`}>
                                {p.status}
                              </span>
                              {p.progress > 0 && (
                                <>
                                  <span>·</span>
                                  <span>{p.progress}%</span>
                                </>
                              )}
                            </div>
                          </button>
                          {isExpanded && (
                            <div className="cl-project-chats">
                              <button
                                type="button"
                                className="cl-new-btn"
                                onClick={() => void createProjectChat(p.id)}
                              >
                                <span>＋</span>
                                <span>New chat</span>
                              </button>
                              {chatsLoading && !chats ? (
                                <div className="cl-list-empty">Loading chats…</div>
                              ) : chats && chats.length > 0 ? (
                                chats.map((c) => (
                                  <button
                                    key={c.id}
                                    type="button"
                                    className="cl-row cl-chat-row"
                                    title={c.title}
                                    onClick={onMobileClose}
                                  >
                                    <div className="cl-row-main">
                                      <span className="cl-row-title">{c.title}</span>
                                    </div>
                                    <div className="cl-row-meta">
                                      <span>{c.messageCount} msg</span>
                                      <span>·</span>
                                      <span>{relativeTime(c.updatedMs)}</span>
                                    </div>
                                  </button>
                                ))
                              ) : chatsErr ? (
                                <div className="cl-list-empty" title={chatsErr}>
                                  {chatsErr.length > 60 ? `${chatsErr.slice(0, 57)}…` : chatsErr}
                                </div>
                              ) : (
                                <div className="cl-list-empty">No chats yet.</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : projectsErr ? (
                  <div className="cl-list-empty" title={projectsErr}>
                    {projectsErr.length > 60 ? `${projectsErr.slice(0, 57)}…` : projectsErr}
                  </div>
                ) : (
                  <div className="cl-list-empty">No projects yet.</div>
                )}
              </div>
            </div>
          </div>

          {/* Static nav. */}
          <div className="cl-static-nav">
            {STATIC_NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`cl-nav-item ${page === item.id ? "cl-active" : ""}`}
                onClick={() => pick(item.id)}
              >
                <span className="cl-nav-icon">{item.icon}</span>
                <span>{item.label}</span>
                {item.dot && <span className={`cl-nav-dot cl-${item.dot}`} />}
              </button>
            ))}
          </div>
        </nav>

        <div className="cl-sidebar-footer">
          <span className="cl-footer-user" title={user.displayName}>{user.displayName}</span>
          {footerRight}
        </div>
      </aside>
      {mobileOpen && (
        <button
          type="button"
          className="cl-sidebar-scrim"
          aria-label="Close sidebar"
          onClick={onMobileClose}
        />
      )}
    </>
  );
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
