import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type User } from "../api.js";
import { GatewayClient, defaultGatewayUrl, type ConnectionStatus } from "../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";
import { ChatPane } from "./ChatPane.js";
import { ChatDetailView } from "./ChatDetailView.js";
import { ProjectPage } from "./pages/ProjectPage.js";
import { MemoryEditorPage } from "./pages/MemoryEditorPage.js";
import { SubprojectsPage } from "./pages/SubprojectsPage.js";
import { CronPage } from "./pages/CronPage.js";
import { Settings, type SettingsTab } from "./Settings.js";
import { NotificationsInbox } from "./NotificationsInbox.js";
import { Sidebar, type SidebarPage } from "./Sidebar.js";
import { systemApi } from "../system-api.js";
import { ChannelsPage } from "./pages/ChannelsPage.js";
import { McpsPage } from "./pages/McpsPage.js";
import { SkillsPage } from "./pages/SkillsPage.js";
import { ModelsPage } from "./pages/ModelsPage.js";
import { ApprovalsPage } from "./pages/ApprovalsPage.js";
import { DoctorPage } from "./pages/DoctorPage.js";
import { RpcConsolePage } from "./pages/RpcConsolePage.js";
import { SessionsPage } from "./pages/SessionsPage.js";
import { NodesPage } from "./pages/NodesPage.js";
import { ConfigEditorPage } from "./pages/ConfigEditorPage.js";
import { DocsPage } from "./pages/DocsPage.js";
import { SudoGate } from "./SudoGate.js";

type PageKey = SidebarPage;

interface Props {
  user: User;
  onLogout(): void | Promise<void>;
}

export interface SessionSummary {
  sessionKey: string;
  label: string;
  agentId?: string;
  model?: string;
  lastActivityMs?: number;
}

export function ChatApp({ user, onLogout }: Props) {
  const clientRef = useRef<GatewayClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "connecting" });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeChatProject, setActiveChatProject] = useState<string | null>(null);
  const [activeChatTitle, setActiveChatTitle] = useState<string>("");
  const [chatSearchQuery, setChatSearchQuery] = useState<string | null>(null);
  const [activeProjectSlug, setActiveProjectSlug] = useState<string | null>(null);
  const [activeProjectSub, setActiveProjectSub] = useState<string | null>(null);
  const [activeMemoryProject, setActiveMemoryProject] = useState<string | null>(null);
  const [activeWorkspaceMemory, setActiveWorkspaceMemory] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [showInbox, setShowInbox] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState(0);
  const [page, setPage] = useState<PageKey>("chat");

  useEffect(() => {
    const c = new GatewayClient(defaultGatewayUrl());
    clientRef.current = c;
    const off = c.onStatus(setStatus);
    c.connect();
    return () => {
      off();
      c.shutdown();
    };
  }, []);

  // Deep-link routing on mount. The Android side appends the FCM data
  // payload's `deepLink` to the relay URL (e.g. /chat/agent:main:foo or
  // /approvals); we read window.location.pathname and route once, then
  // reset the URL back to "/" so future reloads don't keep replaying it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const path = window.location.pathname;
    if (!path || path === "/" || path === "") return;
    let consumed = false;
    const navOnly: Record<string, PageKey> = {
      "/approvals": "approvals",
      "/skills": "skills",
      "/models": "models",
      "/mcps": "mcps",
      "/channels": "channels",
      "/cron": "cron",
      "/nodes": "nodes",
      "/config": "config",
      "/doctor": "doctor",
      "/rpc": "rpc",
      "/sessions": "sessions",
      "/subprojects": "subprojects",
      "/docs": "docs",
      "/memory": "memory",
      "/tasks": "tasks",
      "/home": "home",
    };
    if (navOnly[path]) {
      setPage(navOnly[path]!);
      consumed = true;
    } else {
      // /chat/<sessionKey> — set active session, land on chat surface.
      const chat = path.match(/^\/chat\/(.+)$/);
      if (chat && chat[1]) {
        setActiveKey(decodeURIComponent(chat[1]));
        setPage("chat");
        consumed = true;
      }
    }
    if (consumed) {
      try { window.history.replaceState(null, "", "/"); } catch { /* noop */ }
    }
  }, []);

  // Refresh sessions when the gateway becomes ready.
  useEffect(() => {
    if (status.kind !== "ready" || !clientRef.current) return;
    const c = clientRef.current;
    void (async () => {
      try {
        const result = await c.call<{ sessions?: unknown[]; entries?: unknown[]; rows?: unknown[] }>(
          "sessions.list",
          {},
        );
        const list = (result.sessions ?? result.entries ?? result.rows ?? []) as Array<Record<string, unknown>>;
        const summaries: SessionSummary[] = list
          .map((row): SessionSummary | null => {
            const key = typeof row.sessionKey === "string"
              ? row.sessionKey
              : typeof row.key === "string"
                ? row.key
                : null;
            if (!key) return null;
            return {
              sessionKey: key,
              label: typeof row.title === "string"
                ? row.title
                : typeof row.label === "string"
                  ? row.label
                  : friendlyLabel(key),
              agentId: typeof row.agentId === "string" ? row.agentId : undefined,
              model: typeof row.model === "string" ? row.model : undefined,
              lastActivityMs: typeof row.lastActivityMs === "number"
                ? row.lastActivityMs
                : typeof row.updatedAt === "number"
                  ? row.updatedAt
                  : undefined,
            };
          })
          .filter((s): s is SessionSummary => s !== null)
          .sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));

        // Always pin the default agent session if not already present.
        const DEFAULT_KEY = "agent:main:main";
        if (!summaries.some((s) => s.sessionKey === DEFAULT_KEY)) {
          summaries.unshift({ sessionKey: DEFAULT_KEY, label: "main (default)" });
        }
        setSessions(summaries);
        setActiveKey((prev) => prev ?? summaries[0]?.sessionKey ?? DEFAULT_KEY);
      } catch (err) {
        console.warn("sessions.list failed:", err);
        const fallback: SessionSummary = { sessionKey: "agent:main:main", label: "main (default)" };
        setSessions([fallback]);
        setActiveKey("agent:main:main");
      }
    })();
  }, [status.kind]);

  // Picking a session always lands on the chat page; the sidebar handles
  // the mobile-close so we don't need to mirror that state here.
  const handlePickSession = useCallback((key: string) => {
    setActiveKey(key);
    setActiveChatId(null);
    setActiveChatProject(null);
    setActiveProjectSlug(null);
    setActiveMemoryProject(null);
    setActiveWorkspaceMemory(false);
    setPage("chat");
  }, []);

  const handlePickChat = useCallback((chatId: string, projectSlug: string | null, searchQuery?: string) => {
    setActiveChatId(chatId);
    setActiveChatProject(projectSlug);
    setActiveChatTitle("");
    setActiveProjectSlug(null);
    setActiveMemoryProject(null);
    setChatSearchQuery(searchQuery && searchQuery.trim() ? searchQuery.trim() : null);
    setPage("chat");
  }, []);

  const handlePickProject = useCallback((slug: string) => {
    setActiveProjectSlug(slug);
    setActiveProjectSub(null);
    setActiveChatId(null);
    setActiveChatProject(null);
    setActiveChatTitle("");
    setActiveMemoryProject(null);
    setActiveWorkspaceMemory(false);
    setPage("chat");
  }, []);

  const handleOpenSubproject = useCallback((parentSlug: string, subSlug: string) => {
    setActiveProjectSlug(parentSlug);
    setActiveProjectSub(subSlug);
    setActiveChatId(null);
    setActiveChatProject(null);
    setActiveChatTitle("");
    setActiveMemoryProject(null);
    setActiveWorkspaceMemory(false);
    setPage("chat");
  }, []);

  const handlePickProjectMemory = useCallback((slug: string) => {
    setActiveMemoryProject(slug);
    setActiveWorkspaceMemory(false);
    setActiveProjectSlug(null);
    setActiveChatId(null);
    setActiveChatProject(null);
    setActiveChatTitle("");
    setPage("chat");
  }, []);

  const handlePickWorkspaceMemory = useCallback(() => {
    setActiveWorkspaceMemory(true);
    setActiveMemoryProject(null);
    setActiveProjectSlug(null);
    setActiveChatId(null);
    setActiveChatProject(null);
    setActiveChatTitle("");
    setPage("chat");
  }, []);

  const handleChatTitle = useCallback((id: string, title: string) => {
    setActiveChatTitle((prev) => (id === activeChatId ? title : prev));
  }, [activeChatId]);

  const handleChatDeleted = useCallback((deletedId: string) => {
    setActiveChatId((curr) => (curr === deletedId ? null : curr));
    setActiveChatProject((curr) => (activeChatId === deletedId ? null : curr));
  }, [activeChatId]);

  const handleSelectPage = useCallback((next: SidebarPage) => {
    if (next === "settings") { setSettingsTab(undefined); setShowSettings(true); return; }
    setPage(next);
  }, []);

  const handleShowPairedDevices = useCallback(() => {
    setSettingsTab("pairing");
    setShowSettings(true);
  }, []);

  // Poll unread count every 20s so the bell badge stays roughly fresh.
  // (Push triggers already fan out via FCM; this is for the web fallback path.)
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await systemApi.notifications(1);
        if (!cancelled) setUnreadCount(list.unread);
      } catch {
        // unauthenticated or relay down — ignore
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Poll pending exec-approvals so the sidebar Approvals row shows a badge
  // whenever something is waiting. Mirrors the notifications-bell cadence;
  // exec.approval.requested events also pump this between ticks.
  useEffect(() => {
    if (status.kind !== "ready" || !clientRef.current) return;
    const c = clientRef.current;
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await c.call<{ approvals?: unknown[]; pending?: unknown[] }>(
          "exec.approval.list",
          {},
        );
        const list = (result.approvals ?? result.pending ?? []) as unknown[];
        if (!cancelled) setPendingApprovalsCount(list.length);
      } catch {
        // scope errors / unavailable — leave badge at last known count
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 20_000);
    // Pump on lifecycle events so the badge updates between polls.
    const off = c.onEvent((ev) => {
      if (
        ev.event === "exec.approval.requested"
        || ev.event === "exec.approval.resolved"
      ) {
        void tick();
      }
    });
    return () => { cancelled = true; clearInterval(id); off(); };
  }, [status.kind]);

  const pill = useMemo(() => statusPill(status), [status]);

  if (showSettings) {
    return (
      <>
        <Settings
          user={user}
          onClose={() => setShowSettings(false)}
          initialTab={settingsTab}
          client={clientRef.current}
          status={status}
        />
        <SudoGate />
      </>
    );
  }

  if (showInbox) {
    return (
      <>
        <NotificationsInbox
          onClose={() => {
            setShowInbox(false);
            // Refresh badge after the user dismisses (they may have marked stuff read).
            void systemApi.notifications(1).then((l) => setUnreadCount(l.unread)).catch(() => {});
          }}
          onOpenDeepLink={(link) => {
            // /chat/<sessionKey> deep links jump to that session.
            const m = link.match(/^\/chat\/(.+)$/);
            if (m) {
              setActiveKey(m[1] ?? null);
              setShowInbox(false);
            }
          }}
        />
        <SudoGate />
      </>
    );
  }

  const toolbar = (
    <>
      <button
        className="bell-btn"
        aria-label="notifications"
        onClick={() => setShowInbox(true)}
        title={unreadCount > 0 ? `${unreadCount} unread` : "Notifications"}
      >
        🔔
        {unreadCount > 0 && (
          <span className="bell-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
        )}
      </button>
      <span className={`status-pill ${pill.cls}`}>
        <span className="status-dot" />
        {pill.label}
      </span>
    </>
  );

  const activeSession = sessions.find((s) => s.sessionKey === activeKey);

  return (
    <div className="cl-app-shell">
      <Sidebar
        user={user}
        page={page}
        onSelectPage={handleSelectPage}
        sessions={sessions}
        activeSessionKey={activeKey}
        onPickSession={handlePickSession}
        activeChatId={activeChatId}
        onPickChat={handlePickChat}
        onChatDeleted={handleChatDeleted}
        activeProjectSlug={activeProjectSlug}
        onPickProject={handlePickProject}
        activeMemoryProject={activeMemoryProject}
        onPickProjectMemory={handlePickProjectMemory}
        activeWorkspaceMemory={activeWorkspaceMemory}
        onPickWorkspaceMemory={handlePickWorkspaceMemory}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        onLogout={onLogout}
        onShowPairedDevices={handleShowPairedDevices}
        client={clientRef.current}
        status={status}
        pendingApprovalsCount={pendingApprovalsCount}
        footerRight={
          <span className={`status-pill ${pill.cls}`}>
            <span className="status-dot" />
            {pill.label}
          </span>
        }
      />

      <main className="cl-main">
        <div className="page-toolbar" style={{ justifyContent: "space-between" }}>
          <button
            type="button"
            className="cl-hamburger"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
          >☰</button>
          <div style={{ flex: 1, minWidth: 0, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {page === "chat"
              ? (activeProjectSlug
                  ? `${activeProjectSlug} · project`
                  : activeMemoryProject
                    ? `${activeMemoryProject} · memory`
                  : activeWorkspaceMemory
                    ? "Workspace · memory"
                  : activeChatId
                    ? (activeChatTitle || (activeChatProject ? `${activeChatProject} · chat` : "Chat"))
                    : (activeSession?.label ?? "No session"))
              : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>{toolbar}</div>
        </div>

        {page === "chat" && (
          clientRef.current ? (
            activeWorkspaceMemory ? (
              <MemoryEditorPage
                key="memory:@workspace"
                client={clientRef.current}
                status={status}
                projectSlug={null}
              />
            ) : activeMemoryProject ? (
              <MemoryEditorPage
                key={`memory:${activeMemoryProject}`}
                client={clientRef.current}
                status={status}
                projectSlug={activeMemoryProject}
              />
            ) : activeProjectSlug ? (
              <ProjectPage
                key={`project:${activeProjectSlug}:${activeProjectSub ?? ""}`}
                client={clientRef.current}
                status={status}
                projectSlug={activeProjectSlug}
                initialSubSlug={activeProjectSub ?? undefined}
              />
            ) : activeChatId ? (
              <ChatDetailView
                key={activeChatId}
                client={clientRef.current}
                chatId={activeChatId}
                projectSlug={activeChatProject}
                status={status}
                onTitleChange={handleChatTitle}
                initialSearchQuery={chatSearchQuery ?? undefined}
              />
            ) : activeKey ? (
              <ChatPane
                key={activeKey}
                client={clientRef.current}
                sessionKey={activeKey}
                status={status}
              />
            ) : (
              <div className="empty"><div className="big">⏳</div>Waiting for session…</div>
            )
          ) : (
            <div className="empty"><div className="big">⏳</div>Waiting for session…</div>
          )
        )}
        {page === "sessions" && (
          <SessionsPage
            client={clientRef.current}
            status={status}
            onOpenSession={(k) => { setActiveKey(k); setActiveChatId(null); setActiveChatProject(null); setPage("chat"); }}
          />
        )}
        {page === "subprojects" && (
          <SubprojectsPage
            client={clientRef.current}
            status={status}
            onOpen={handleOpenSubproject}
          />
        )}
        {page === "channels" && <ChannelsPage client={clientRef.current} status={status} />}
        {page === "mcps" && <McpsPage client={clientRef.current} status={status} />}
        {page === "skills" && <SkillsPage client={clientRef.current} status={status} />}
        {page === "models" && <ModelsPage client={clientRef.current} status={status} />}
        {page === "approvals" && <ApprovalsPage client={clientRef.current} status={status} />}
        {page === "cron" && <CronPage client={clientRef.current} status={status} />}
        {page === "nodes" && <NodesPage client={clientRef.current} status={status} />}
        {page === "config" && <ConfigEditorPage client={clientRef.current} status={status} />}
        {page === "docs" && <DocsPage client={clientRef.current} status={status} />}
        {page === "doctor" && <DoctorPage client={clientRef.current} status={status} />}
        {page === "rpc" && <RpcConsolePage client={clientRef.current} status={status} />}
      </main>
      <SudoGate />
    </div>
  );
}

function friendlyLabel(key: string): string {
  const parts = key.split(":");
  if (parts[0] === "agent" && parts.length >= 3) {
    const agentId = parts[1] ?? "?";
    const tail = parts.slice(2).join(":");
    return `${agentId} · ${tail}`;
  }
  return key;
}

function statusPill(s: ConnectionStatus): { cls: string; label: string } {
  switch (s.kind) {
    case "ready":            return { cls: "ok",   label: "online" };
    case "connecting":       return { cls: "warn", label: "connecting…" };
    case "session-handshaking": return { cls: "warn", label: "handshaking…" };
    case "agent-offline":    return { cls: "bad",  label: "tunnel offline" };
    case "failed":           return { cls: "bad",  label: `failed: ${s.reason.slice(0, 40)}` };
    case "closed":           return { cls: "bad",  label: `closed (${s.code})` };
  }
}

// Re-export type for child components.
export type { OpenClawEvent };
