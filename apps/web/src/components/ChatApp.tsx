import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type User } from "../api.js";
import { GatewayClient, defaultGatewayUrl, type ConnectionStatus } from "../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";
import { ChatPane } from "./ChatPane.js";
import { ChatDetailView } from "./ChatDetailView.js";
import { ProjectPage } from "./pages/ProjectPage.js";
import { MemoryEditorPage } from "./pages/MemoryEditorPage.js";
import { Settings } from "./Settings.js";
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
  const [activeProjectSlug, setActiveProjectSlug] = useState<string | null>(null);
  const [activeMemoryProject, setActiveMemoryProject] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
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
    setPage("chat");
  }, []);

  const handlePickChat = useCallback((chatId: string, projectSlug: string | null) => {
    setActiveChatId(chatId);
    setActiveChatProject(projectSlug);
    setActiveChatTitle("");
    setActiveProjectSlug(null);
    setActiveMemoryProject(null);
    setPage("chat");
  }, []);

  const handlePickProject = useCallback((slug: string) => {
    setActiveProjectSlug(slug);
    setActiveChatId(null);
    setActiveChatProject(null);
    setActiveChatTitle("");
    setActiveMemoryProject(null);
    setPage("chat");
  }, []);

  const handlePickProjectMemory = useCallback((slug: string) => {
    setActiveMemoryProject(slug);
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
    if (next === "settings") { setShowSettings(true); return; }
    setPage(next);
  }, []);

  const handleShowPairedDevices = useCallback(async () => {
    const tokens = await api.listPairingTokens();
    const lines = tokens
      .map((t) => `• ${t.label} — last used ${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}`)
      .join("\n");
    alert(`Paired devices:\n${lines || "(none)"}`);
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

  const pill = useMemo(() => statusPill(status), [status]);

  if (showSettings) {
    return <Settings user={user} onClose={() => setShowSettings(false)} />;
  }

  if (showInbox) {
    return (
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
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        onLogout={onLogout}
        onShowPairedDevices={handleShowPairedDevices}
        client={clientRef.current}
        status={status}
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
                  : activeChatId
                    ? (activeChatTitle || (activeChatProject ? `${activeChatProject} · chat` : "Chat"))
                    : (activeSession?.label ?? "No session"))
              : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>{toolbar}</div>
        </div>

        {page === "chat" && (
          clientRef.current ? (
            activeMemoryProject ? (
              <MemoryEditorPage
                key={`memory:${activeMemoryProject}`}
                client={clientRef.current}
                status={status}
                projectSlug={activeMemoryProject}
              />
            ) : activeProjectSlug ? (
              <ProjectPage
                key={`project:${activeProjectSlug}`}
                client={clientRef.current}
                status={status}
                projectSlug={activeProjectSlug}
              />
            ) : activeChatId ? (
              <ChatDetailView
                key={activeChatId}
                client={clientRef.current}
                chatId={activeChatId}
                projectSlug={activeChatProject}
                status={status}
                onTitleChange={handleChatTitle}
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
        {page === "channels" && <ChannelsPage client={clientRef.current} status={status} />}
        {page === "mcps" && <McpsPage client={clientRef.current} status={status} />}
        {page === "skills" && <SkillsPage client={clientRef.current} status={status} />}
        {page === "models" && <ModelsPage client={clientRef.current} status={status} />}
        {page === "approvals" && <ApprovalsPage client={clientRef.current} status={status} />}
        {page === "doctor" && <DoctorPage client={clientRef.current} status={status} />}
        {page === "rpc" && <RpcConsolePage client={clientRef.current} status={status} />}
      </main>
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
