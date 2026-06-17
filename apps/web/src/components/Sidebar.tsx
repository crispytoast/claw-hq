import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionSummary, ChatRecentSummary, ChatStatus, ChatKind } from "./ChatApp.js";

const CLAWHQ_SESSION_PREFIX = "agent:main:clawhq-";
import type { User } from "../api.js";
import type { GatewayClient, ConnectionStatus } from "../gateway.js";
import {
  Home, Leaf, Check, Books, Brain, Tools, Models, Hand, Clock, Phone,
  Settings, Stethoscope, Plug, Chat, Plus, Clipboard, Chevron, Kebab, X, Folder,
} from "./icons.js";

export type SidebarPage =
  | "chat"
  | "sessions"
  | "subprojects"
  | "channels"
  | "mcps"
  | "skills"
  | "models"
  | "approvals"
  | "cron"
  | "nodes"
  | "config"
  | "doctor"
  | "rpc"
  | "docs"
  | "memory"
  | "tasks"
  | "home"
  | "settings";

interface NavItem {
  id: Exclude<SidebarPage, "chat">;
  label: string;
  icon: React.ReactNode;
  dot?: "amber" | "green";
}

// Order mirrors OHQ's static nav: live surfaces first, ops/debug last,
// Settings always at the bottom. "Sessions" lives in the expandable group above.
const STATIC_NAV: NavItem[] = [
  { id: "home",        label: "Home",        icon: <Home /> },
  { id: "subprojects", label: "Subprojects", icon: <Leaf /> },
  { id: "tasks",       label: "Tasks",       icon: <Check /> },
  { id: "docs",        label: "Docs",        icon: <Books /> },
  { id: "memory",      label: "Memory",      icon: <Brain /> },
  { id: "channels",    label: "Channels",    icon: <Chat /> },
  { id: "mcps",        label: "MCPs",        icon: <Plug /> },
  { id: "skills",      label: "Skills",      icon: <Tools /> },
  { id: "models",      label: "Models",      icon: <Models /> },
  { id: "approvals",   label: "Approvals",   icon: <Hand /> },
  { id: "cron",        label: "Cron",        icon: <Clock /> },
  { id: "nodes",       label: "Nodes",       icon: <Phone /> },
  { id: "config",      label: "Config",      icon: <Settings /> },
  { id: "doctor",      label: "Doctor",      icon: <Stethoscope /> },
  { id: "rpc",         label: "RPC",         icon: <Plug /> },
  { id: "settings",    label: "Settings",    icon: <Settings /> },
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

interface SnippetHit {
  messageId: string;
  role: "user" | "assistant" | "system";
  createdMs: number;
  snippet: string;
}

interface ChatSearchHit {
  id: string;
  projectSlug: string | null;
  title: string;
  updatedMs: number;
  matchCount: number;
  snippets: SnippetHit[];
}

interface ChatSearchResponse {
  hits: ChatSearchHit[];
  totalChatsScanned: number;
  query: string;
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
  activeChatId: string | null;
  activeChatKind?: ChatKind;
  onPickChat(chatId: string, projectSlug: string | null, searchQuery?: string): void;
  /** Open (or create on first use) the pinned Head Oswald chat. */
  onPickHeadOswald(): void | Promise<void>;
  onChatDeleted?(chatId: string): void;
  activeProjectSlug: string | null;
  onPickProject(slug: string): void;
  activeMemoryProject: string | null;
  onPickProjectMemory(slug: string): void;
  activeWorkspaceMemory: boolean;
  onPickWorkspaceMemory(): void;
  /** User-facing chat records (clawhq.chats.list across all projects), sorted
   * by updatedMs desc. Shown in the Sessions group's Recent section. */
  recentChats: ChatRecentSummary[];
  /** Per-chat live status: orange (running) / green (done). Drawn next to
   * each chat row in Recent. */
  chatStatuses: Map<string, ChatStatus>;
  mobileOpen: boolean;
  onMobileClose(): void;
  onLogout(): void | Promise<void>;
  onShowPairedDevices?(): void | Promise<void>;
  footerRight?: React.ReactNode;
  client: GatewayClient | null;
  status: ConnectionStatus;
  pendingApprovalsCount?: number;
}

export function Sidebar({
  user,
  page,
  onSelectPage,
  sessions,
  activeSessionKey,
  onPickSession,
  activeChatId,
  activeChatKind,
  onPickChat,
  onPickHeadOswald,
  onChatDeleted,
  activeProjectSlug,
  onPickProject,
  activeMemoryProject,
  onPickProjectMemory,
  activeWorkspaceMemory,
  onPickWorkspaceMemory,
  recentChats,
  chatStatuses,
  mobileOpen,
  onMobileClose,
  onLogout,
  onShowPairedDevices,
  footerRight,
  client,
  status,
  pendingApprovalsCount = 0,
}: Props) {
  // OHQ pattern: the group that matches the current page starts expanded.
  const [sessionsOpen, setSessionsOpen] = useState(page === "chat" || page === "sessions");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | string>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsErr, setProjectsErr] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [projectChats, setProjectChats] = useState<Map<string, ChatSummary[]>>(new Map());
  const [projectChatsLoading, setProjectChatsLoading] = useState<Set<string>>(new Set());
  const [projectChatsErr, setProjectChatsErr] = useState<Map<string, string>>(new Map());
  /** chatId whose row actions popover is open. */
  const [actionsOpenForChat, setActionsOpenForChat] = useState<string | null>(null);
  /** chatId currently being inline-renamed, with its draft title. */
  const [renamingChat, setRenamingChat] = useState<{ chatId: string; draft: string } | null>(null);
  /** Live chat-search input. */
  const [searchInput, setSearchInput] = useState("");
  /** Active query (debounced) being executed against the plugin. */
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChatSearchHit[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

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

  const commitRename = useCallback(async () => {
    if (!client || status.kind !== "ready" || !renamingChat) return;
    const { chatId, draft } = renamingChat;
    const title = draft.trim();
    setRenamingChat(null);
    if (!title) return;
    try {
      await client.call("clawhq.chats.rename", { chatId, title });
      // Optimistic update; the broadcast will also land and idempotently re-apply.
      setProjectChats((m) => {
        const next = new Map(m);
        for (const [slug, list] of m) {
          const idx = list.findIndex((c) => c.id === chatId);
          if (idx === -1) continue;
          const updated: ChatSummary = { ...list[idx]!, title, updatedMs: Date.now() };
          const reordered = [updated, ...list.slice(0, idx), ...list.slice(idx + 1)];
          reordered.sort((a, b) => b.updatedMs - a.updatedMs);
          next.set(slug, reordered);
        }
        return next;
      });
    } catch (err) {
      console.warn("clawhq.chats.rename failed:", err);
    }
  }, [client, status.kind, renamingChat]);

  const deleteChatRow = useCallback(
    async (chatId: string, title: string) => {
      if (!client || status.kind !== "ready") return;
      const confirmed = window.confirm(`Delete "${title}"? This can't be undone.`);
      if (!confirmed) return;
      try {
        await client.call("clawhq.chats.delete", { chatId });
        setProjectChats((m) => {
          const next = new Map(m);
          for (const [slug, list] of m) {
            const filtered = list.filter((c) => c.id !== chatId);
            if (filtered.length !== list.length) next.set(slug, filtered);
          }
          return next;
        });
        if (onChatDeleted) onChatDeleted(chatId);
      } catch (err) {
        console.warn("clawhq.chats.delete failed:", err);
      }
    },
    [client, status.kind, onChatDeleted],
  );

  // Close row-actions popover on any outside click.
  useEffect(() => {
    if (!actionsOpenForChat) return;
    const onDocClick = () => setActionsOpenForChat(null);
    window.addEventListener("click", onDocClick);
    return () => window.removeEventListener("click", onDocClick);
  }, [actionsOpenForChat]);

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
      onPickChat(data.chat.id, projectId);
      onMobileClose();
    } catch (err) {
      setProjectChatsErr((m) =>
        new Map(m).set(projectId, err instanceof Error ? err.message : String(err)),
      );
    }
  }

  useEffect(() => {
    if (page === "chat" || page === "sessions") setSessionsOpen(true);
  }, [page]);

  // Cross-device live feed: rename/delete/create/append broadcasts keep the
  // sidebar in sync with the other devices without round-trips.
  useEffect(() => {
    if (!client) return;
    return client.onEvent((ev) => {
      if (ev.event === "plugin.clawhq.chat.message") {
        const p = (ev.payload ?? {}) as {
          chatId?: unknown;
          projectSlug?: unknown;
          updatedMs?: unknown;
          messageCount?: unknown;
        };
        if (typeof p.chatId !== "string" || typeof p.projectSlug !== "string") return;
        const projectSlug = p.projectSlug;
        const chatId = p.chatId;
        const updatedMs = typeof p.updatedMs === "number" ? p.updatedMs : Date.now();
        const messageCount = typeof p.messageCount === "number" ? p.messageCount : undefined;
        setProjectChats((m) => {
          const list = m.get(projectSlug);
          if (!list) return m;
          const idx = list.findIndex((c) => c.id === chatId);
          if (idx === -1) return m;
          const existing = list[idx]!;
          const updated: ChatSummary = {
            ...existing,
            updatedMs,
            messageCount: messageCount ?? existing.messageCount,
          };
          const next = [updated, ...list.slice(0, idx), ...list.slice(idx + 1)];
          next.sort((a, b) => b.updatedMs - a.updatedMs);
          return new Map(m).set(projectSlug, next);
        });
        return;
      }
      if (ev.event === "plugin.clawhq.chat.renamed") {
        const p = (ev.payload ?? {}) as {
          chatId?: unknown;
          projectSlug?: unknown;
          title?: unknown;
          updatedMs?: unknown;
        };
        if (typeof p.chatId !== "string" || typeof p.title !== "string") return;
        const updatedMs = typeof p.updatedMs === "number" ? p.updatedMs : Date.now();
        setProjectChats((m) => {
          const next = new Map(m);
          for (const [slug, list] of m) {
            const idx = list.findIndex((c) => c.id === p.chatId);
            if (idx === -1) continue;
            const updated: ChatSummary = { ...list[idx]!, title: p.title as string, updatedMs };
            const reordered = [updated, ...list.slice(0, idx), ...list.slice(idx + 1)];
            reordered.sort((a, b) => b.updatedMs - a.updatedMs);
            next.set(slug, reordered);
          }
          return next;
        });
        return;
      }
      if (ev.event === "plugin.clawhq.chat.deleted") {
        const p = (ev.payload ?? {}) as { chatId?: unknown };
        if (typeof p.chatId !== "string") return;
        const chatId = p.chatId;
        setProjectChats((m) => {
          const next = new Map(m);
          for (const [slug, list] of m) {
            const filtered = list.filter((c) => c.id !== chatId);
            if (filtered.length !== list.length) next.set(slug, filtered);
          }
          return next;
        });
        if (onChatDeleted) onChatDeleted(chatId);
        return;
      }
      if (ev.event === "plugin.clawhq.chat.created") {
        const p = (ev.payload ?? {}) as { chat?: unknown };
        const chat = p.chat as ChatSummary | undefined;
        if (!chat || typeof chat.id !== "string" || typeof chat.projectSlug !== "string") return;
        const projectSlug = chat.projectSlug;
        setProjectChats((m) => {
          const list = m.get(projectSlug);
          if (!list) return m;
          if (list.some((c) => c.id === chat.id)) return m;
          const next = [chat, ...list];
          next.sort((a, b) => b.updatedMs - a.updatedMs);
          return new Map(m).set(projectSlug, next);
        });
        return;
      }
    });
  }, [client, onChatDeleted]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = () => setMenuOpen(false);
    window.addEventListener("click", onDocClick);
    return () => window.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  // Debounce the search input → searchQuery so we don't slam the plugin every
  // keystroke. 200ms feels snappy without being chatty.
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed.length < 2) {
      setSearchQuery("");
      setSearchResults(null);
      setSearchErr(null);
      return;
    }
    const id = setTimeout(() => setSearchQuery(trimmed), 200);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Fire the actual search whenever searchQuery changes.
  useEffect(() => {
    if (!client || status.kind !== "ready" || !searchQuery) return;
    let cancelled = false;
    setSearchLoading(true);
    setSearchErr(null);
    void client
      .call<ChatSearchResponse>("clawhq.chats.search", { query: searchQuery, limit: 30 })
      .then((res) => {
        if (cancelled) return;
        setSearchResults(res.hits);
      })
      .catch((err) => {
        if (cancelled) return;
        setSearchErr(err instanceof Error ? err.message : String(err));
        setSearchResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, status.kind, searchQuery]);

  const searching = searchQuery.length > 0;

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

  // Agents group = raw OpenClaw runtime sessions MINUS the per-chat backing
  // sessions Claw HQ auto-creates (those are surfaced by their chat title in
  // Recent / under Projects). Leaves agent:main:main and any non-clawhq
  // sessions for advanced/debug use.
  const agentSessions = useMemo(
    () => sessions.filter((s) => !s.sessionKey.startsWith(CLAWHQ_SESSION_PREFIX)),
    [sessions],
  );

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
            style={{ marginLeft: "auto", color: "var(--muted-foreground)", padding: "4px 6px", display: "inline-flex", alignItems: "center" }}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          ><Kebab size={16} /></button>
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
              <span className="cl-group-icon"><Chat /></span>
              <span>Sessions</span>
              <span className="cl-group-chevron"><Chevron dir={sessionsOpen ? "down" : "right"} size={12} /></span>
            </button>

            <div className={`cl-group-body ${sessionsOpen ? "cl-expanded" : ""}`}>
              <div className="cl-group-inner">
                <div className="cl-search-wrap">
                  <input
                    type="search"
                    className="cl-search-input"
                    placeholder="Search chats…"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                  />
                  {searchInput && (
                    <button
                      type="button"
                      className="cl-search-clear"
                      aria-label="Clear search"
                      onClick={() => setSearchInput("")}
                    ><X size={12} /></button>
                  )}
                </div>

                {searching ? (
                  <>
                    {searchLoading && searchResults === null && (
                      <div className="cl-list-empty">Searching…</div>
                    )}
                    {searchErr && <div className="cl-list-empty" title={searchErr}>{searchErr.slice(0, 60)}</div>}
                    {searchResults && (
                      <>
                        <div className="cl-section-label">
                          {searchResults.length === 0 ? "No matches" : `${searchResults.length} chat${searchResults.length === 1 ? "" : "s"} matched`}
                        </div>
                        <div className="cl-list">
                          {searchResults.map((h) => {
                            const isHitActive = activeChatId === h.id;
                            return (
                              <button
                                key={h.id}
                                type="button"
                                className={`cl-row cl-search-hit ${isHitActive ? "cl-active" : ""}`}
                                title={h.title}
                                onClick={() => {
                                  onPickChat(h.id, h.projectSlug, searchQuery);
                                  onMobileClose();
                                }}
                              >
                                <div className="cl-row-main">
                                  <span className="cl-row-title">{h.title}</span>
                                  {h.snippets[0] && (
                                    <span className="cl-search-snippet">
                                      <span className="cl-search-role">{h.snippets[0].role}:</span>{" "}
                                      {h.snippets[0].snippet}
                                    </span>
                                  )}
                                </div>
                                <div className="cl-row-meta">
                                  {h.projectSlug && (
                                    <>
                                      <span className="cl-row-tag">{h.projectSlug}</span>
                                      <span>·</span>
                                    </>
                                  )}
                                  <span>{h.matchCount} hit{h.matchCount === 1 ? "" : "s"}</span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="cl-new-btn"
                      onClick={() => pick("sessions")}
                      title="Browse all sessions"
                    >
                      <Plus size={12} />
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

                    {/* Recent = clawhq.chats.list, sorted by updatedMs desc.
                        The agent-filter chips above are vestigial for chats
                        (they filter raw sessions, not chats) — hide the
                        Recent body when a non-"all" filter is active so the
                        chips still gate something meaningful. Head Oswald
                        chats are excluded here because they have their own
                        pinned row above Projects (Phase 8.1). */}
                    {(() => null)()}
                    {filter === "all" && recentChats.filter((c) => c.kind !== "head").length > 0 && (
                      <div className="cl-section-label">Recent</div>
                    )}

                    <div className="cl-list">
                      {filter !== "all" ? (
                        <div className="cl-list-empty">Recent chats ignore the agent filter — switch to All to see them.</div>
                      ) : recentChats.filter((c) => c.kind !== "head").length === 0 ? (
                        <div className="cl-list-empty">No chats yet.</div>
                      ) : (
                        recentChats.filter((c) => c.kind !== "head").map((chat) => {
                          const isActive = page === "chat" && chat.id === activeChatId;
                          const statusKind = chatStatuses.get(chat.id);
                          return (
                            <button
                              key={chat.id}
                              type="button"
                              className={`cl-row ${isActive ? "cl-active" : ""}`}
                              onClick={() => {
                                onPickChat(chat.id, chat.projectSlug);
                                onMobileClose();
                              }}
                            >
                              <div className="cl-row-main">
                                <span className="cl-row-title">
                                  {statusKind && (
                                    <span
                                      className={`cl-chat-status cl-chat-status-${statusKind}`}
                                      aria-label={statusKind === "running" ? "agent running" : "response ready"}
                                      title={statusKind === "running" ? "Agent running" : "Response ready"}
                                    />
                                  )}
                                  {chat.title || "(untitled)"}
                                </span>
                              </div>
                              <div className="cl-row-meta">
                                {chat.projectSlug && (
                                  <>
                                    <span className="cl-row-tag">{chat.projectSlug}</span>
                                    <span>·</span>
                                  </>
                                )}
                                <span>{chat.updatedMs ? relativeTime(chat.updatedMs) : "—"}</span>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Head Oswald — pinned chat surface for portfolio-level conversations
              (Phase 8.1). Routes to a kind="head" chat with session-key prefix
              `agent:main:oswald-*`. Distinct from project chats below. */}
          <div className="cl-sidebar-group cl-head-oswald-group">
            <button
              type="button"
              className={`cl-head-oswald-row ${activeChatKind === "head" ? "cl-active" : ""}`}
              onClick={() => { void onPickHeadOswald(); }}
              title="Portfolio-level chat with head Oswald (separate from project specialists)"
            >
              <span className="cl-head-oswald-icon" aria-hidden="true">🦉</span>
              <span className="cl-head-oswald-label">Head Oswald</span>
            </button>
          </div>

          {/* Projects — placeholder for Phase C (workspace cards). */}
          <div className="cl-sidebar-group">
            <button
              type="button"
              className="cl-group-header"
              onClick={() => setProjectsOpen((v) => !v)}
              aria-expanded={projectsOpen}
            >
              <span className="cl-group-icon"><Folder /></span>
              <span>Projects</span>
              <span className="cl-group-chevron"><Chevron dir={projectsOpen ? "down" : "right"} size={12} /></span>
            </button>
            <div className={`cl-group-body ${projectsOpen ? "cl-expanded" : ""}`}>
              <div className="cl-group-inner">
                <button
                  type="button"
                  className={`cl-row ${activeWorkspaceMemory ? "cl-active" : ""}`}
                  title="Edit shared workspace memory (workspace/memory/*.md)"
                  onClick={() => { onPickWorkspaceMemory(); onMobileClose(); }}
                >
                  <div className="cl-row-main">
                    <span className="cl-row-title" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <Brain /> Workspace memory
                    </span>
                  </div>
                </button>
                {projectsLoading && projects === null ? (
                  <div className="cl-list-empty">Loading projects…</div>
                ) : projects && projects.length > 0 ? (
                  <div className="cl-list">
                    {projects.map((p) => {
                      const isExpanded = expandedProjects.has(p.id);
                      const chats = projectChats.get(p.id);
                      const chatsLoading = projectChatsLoading.has(p.id);
                      const chatsErr = projectChatsErr.get(p.id);
                      const isProjectActive = activeProjectSlug === p.id;
                      const isMemoryActive = activeMemoryProject === p.id;
                      return (
                        <div key={p.id} className="cl-project-block" style={{ position: "relative" }}>
                          <button
                            type="button"
                            className={`cl-row ${isProjectActive || isMemoryActive ? "cl-active" : ""}`}
                            title={p.blurb || p.name}
                            style={{ paddingRight: 96 }}
                            onClick={() => toggleProject(p.id)}
                          >
                            <div className="cl-row-main">
                              <span className="cl-row-title">
                                <span className="cl-project-chevron"><Chevron dir={isExpanded ? "down" : "right"} size={12} /></span>
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
                          <button
                            type="button"
                            className="cl-project-open"
                            aria-label={`Open ${p.name} project page`}
                            title="Open project home"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPickProject(p.id);
                              onMobileClose();
                            }}
                          ><Clipboard size={13} /></button>
                          <button
                            type="button"
                            className="cl-project-memory"
                            aria-label={`Open ${p.name} memory editor`}
                            title="Edit project memory"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPickProjectMemory(p.id);
                              onMobileClose();
                            }}
                          ><Brain size={13} /></button>
                          {isExpanded && (
                            <div className="cl-project-chats">
                              <button
                                type="button"
                                className="cl-new-btn"
                                onClick={() => void createProjectChat(p.id)}
                              >
                                <Plus size={12} />
                                <span>New chat</span>
                              </button>
                              {chatsLoading && !chats ? (
                                <div className="cl-list-empty">Loading chats…</div>
                              ) : chats && chats.length > 0 ? (
                                chats.map((c) => {
                                  const isChatActive = activeChatId === c.id;
                                  const isRenaming = renamingChat?.chatId === c.id;
                                  const isActionsOpen = actionsOpenForChat === c.id;
                                  return (
                                    <div key={c.id} className="cl-chat-row-wrap" style={{ position: "relative" }}>
                                      {isRenaming ? (
                                        <div className={`cl-row cl-chat-row ${isChatActive ? "cl-active" : ""}`}>
                                          <input
                                            autoFocus
                                            className="cl-rename-input"
                                            value={renamingChat.draft}
                                            onChange={(e) =>
                                              setRenamingChat({ chatId: c.id, draft: e.target.value })
                                            }
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter") {
                                                e.preventDefault();
                                                void commitRename();
                                              } else if (e.key === "Escape") {
                                                e.preventDefault();
                                                setRenamingChat(null);
                                              }
                                            }}
                                            onBlur={() => void commitRename()}
                                          />
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          className={`cl-row cl-chat-row ${isChatActive ? "cl-active" : ""}`}
                                          title={c.title}
                                          onClick={() => {
                                            onPickChat(c.id, c.projectSlug);
                                            onMobileClose();
                                          }}
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
                                      )}
                                      {!isRenaming && (
                                        <button
                                          type="button"
                                          className="cl-chat-row-actions"
                                          aria-label="Chat actions"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setActionsOpenForChat((curr) => (curr === c.id ? null : c.id));
                                          }}
                                        ><Kebab size={13} /></button>
                                      )}
                                      {isActionsOpen && !isRenaming && (
                                        <div
                                          className="menu-popover cl-chat-actions-popover"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          <button
                                            onClick={() => {
                                              setActionsOpenForChat(null);
                                              setRenamingChat({ chatId: c.id, draft: c.title });
                                            }}
                                          >
                                            Rename
                                          </button>
                                          <div className="sep" />
                                          <button
                                            onClick={() => {
                                              setActionsOpenForChat(null);
                                              void deleteChatRow(c.id, c.title);
                                            }}
                                          >
                                            Delete
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })
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

          {/* Agents — raw OpenClaw sessions (default main + any non-Claw HQ
              runtime sessions). Per-chat backing keys (agent:main:clawhq-*)
              are hidden because their human-readable rows show up in Recent
              above and under Projects. */}
          <div className="cl-sidebar-group">
            <button
              type="button"
              className="cl-group-header"
              onClick={() => setAgentsOpen((v) => !v)}
              aria-expanded={agentsOpen}
            >
              <span className="cl-group-icon"><Tools /></span>
              <span>Agents</span>
              <span className="cl-group-chevron"><Chevron dir={agentsOpen ? "down" : "right"} size={12} /></span>
            </button>
            <div className={`cl-group-body ${agentsOpen ? "cl-expanded" : ""}`}>
              <div className="cl-group-inner">
                {agentSessions.length === 0 ? (
                  <div className="cl-list-empty">No background agents.</div>
                ) : (
                  <div className="cl-list">
                    {agentSessions.map((s) => {
                      const isActive = page === "chat" && s.sessionKey === activeSessionKey;
                      const agent = s.agentId ?? s.sessionKey.split(":")[1] ?? null;
                      return (
                        <button
                          key={s.sessionKey}
                          type="button"
                          className={`cl-row ${isActive ? "cl-active" : ""}`}
                          title={s.sessionKey}
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
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Static nav. */}
          <div className="cl-static-nav">
            {STATIC_NAV.map((item) => {
              const badge = item.id === "approvals" && pendingApprovalsCount > 0
                ? pendingApprovalsCount
                : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`cl-nav-item ${page === item.id ? "cl-active" : ""}`}
                  onClick={() => pick(item.id)}
                >
                  <span className="cl-nav-icon">{item.icon}</span>
                  <span>{item.label}</span>
                  {badge !== null && (
                    <span className="cl-nav-item-badge">{badge > 9 ? "9+" : badge}</span>
                  )}
                  {item.dot && !badge && <span className={`cl-nav-dot cl-${item.dot}`} />}
                </button>
              );
            })}
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
