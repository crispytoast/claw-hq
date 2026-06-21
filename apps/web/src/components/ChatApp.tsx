import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type User } from "../api.js";
import { GatewayClient, defaultGatewayUrl, type ConnectionStatus } from "../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";
import { ChatPane } from "./ChatPane.js";
import { ChatDetailView, contentToText } from "./ChatDetailView.js";
import { SystemHealth } from "./SystemHealth.js";
import { Bell, Menu, Hourglass } from "./icons.js";
import { ProjectPage } from "./pages/ProjectPage.js";
import { MemoryEditorPage } from "./pages/MemoryEditorPage.js";
import { SubprojectsPage } from "./pages/SubprojectsPage.js";
import { CronPage } from "./pages/CronPage.js";
import { Settings, type SettingsTab } from "./Settings.js";
import { NotificationsInbox } from "./NotificationsInbox.js";
import { Sidebar, type SidebarPage } from "./Sidebar.js";
import { systemApi } from "../system-api.js";
import { getFastModeDefault } from "../chat-prefs.js";
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
import { WorkspaceMemoryPage } from "./pages/WorkspaceMemoryPage.js";
import { TasksPage } from "./pages/TasksPage.js";
import { HomePage } from "./pages/HomePage.js";
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

export type ChatKind = "project" | "head";

export interface ChatRecentSummary {
  id: string;
  projectSlug: string | null;
  title: string;
  updatedMs: number;
  messageCount: number;
  kind?: ChatKind;
  mode?: "gateway" | "fast";
}

/**
 * Session-key prefix mapping. Returns the leading scope segment used in
 * `agent:main:<prefix>-<chatIdFragment>`. Centralized so the relay's regex
 * and the SPA's session-key constructor stay in lockstep.
 *
 * Mapping:
 *   kind=head                                 → "oswald"
 *   projectSlug="pm-hq"                       → "pmhq"
 *   anything else / undefined / null          → "clawhq"  (back-compat default;
 *                                                every existing chat was
 *                                                created before the per-scope
 *                                                prefix split.)
 */
export function sessionScopePrefix(
  chat: { kind?: ChatKind; projectSlug?: string | null },
): "oswald" | "pmhq" | "clawhq" {
  if (chat.kind === "head") return "oswald";
  if (chat.projectSlug === "pm-hq") return "pmhq";
  return "clawhq";
}

/** Per-chat live status. orange = user sent, awaiting response; green = done. */
export type ChatStatus = "running" | "done";

/** Session keys that back a Claw HQ chat record. Phase 8.1 generalized the
 * scope prefix from `clawhq-` to any lowercase scope (`pmhq-`, `oswald-`, …).
 * Match group 1 = scope, group 2 = 8-char chatId prefix used to bridge
 * agent.end events back to a chatId for status dots + push deep links. */
const CLAWHQ_SESSION_PREFIX_RE = /^agent:main:[a-z]+-([A-Za-z0-9-]+)$/;

export function ChatApp({ user, onLogout }: Props) {
  const clientRef = useRef<GatewayClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "connecting" });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeChatProject, setActiveChatProject] = useState<string | null>(null);
  const [activeChatKind, setActiveChatKind] = useState<ChatKind | undefined>(undefined);
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
  const [recentChats, setRecentChats] = useState<ChatRecentSummary[]>([]);
  const [chatStatuses, setChatStatuses] = useState<Map<string, ChatStatus>>(new Map());
  /** Pending chatId prefix from a /chat-detail/<prefix> deep link. Drained
   * once recentChats is populated (clawhq.chats.list races mount). */
  const [pendingChatPrefix, setPendingChatPrefix] = useState<string | null>(null);
  /** Last sessionKey we saw a clawhq chat event for. Resolves agent.end →
   * chatId via clawhq.chats.list lookup against the 8-char prefix. */
  const recentChatsRef = useRef<ChatRecentSummary[]>([]);
  useEffect(() => { recentChatsRef.current = recentChats; }, [recentChats]);

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
      // /chat-detail/<8-char chatId prefix> — push notification deep-link
      // emitted by ws-routing.ts when a clawhq-backed chat completes. We
      // can't always resolve the prefix at mount (clawhq.chats.list may not
      // have arrived yet), so stash the prefix and let a later effect bind
      // activeChatId once recentChats lands.
      const detail = path.match(/^\/chat-detail\/(.+)$/);
      if (detail && detail[1]) {
        setPendingChatPrefix(decodeURIComponent(detail[1]));
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
    setActiveChatKind(undefined);
    setActiveProjectSlug(null);
    setActiveMemoryProject(null);
    setActiveWorkspaceMemory(false);
    setPage("chat");
  }, []);

  const handlePickChat = useCallback((chatId: string, projectSlug: string | null, searchQuery?: string) => {
    setActiveChatId(chatId);
    setActiveChatProject(projectSlug);
    // kind lookup against the recent-chats cache. For chats not in the cache
    // (cross-device deep link), default to project; the chat-detail loader
    // re-syncs from the persisted record's kind via the history response.
    const cached = recentChatsRef.current.find((c) => c.id === chatId);
    setActiveChatKind(cached?.kind);
    setActiveChatTitle("");
    setActiveProjectSlug(null);
    setActiveMemoryProject(null);
    setChatSearchQuery(searchQuery && searchQuery.trim() ? searchQuery.trim() : null);
    setPage("chat");
  }, []);

  /**
   * Head Oswald entry point. Pinned in the sidebar above Projects. Opens
   * the most recent head chat if one exists; otherwise creates one.
   * Per Phase 8.1.
   */
  const handlePickHeadOswald = useCallback(async () => {
    const c = clientRef.current;
    if (!c || status.kind !== "ready") return;
    const existing = recentChatsRef.current.find((chat) => chat.kind === "head");
    if (existing) {
      setActiveChatId(existing.id);
      setActiveChatProject(null);
      setActiveChatKind("head");
      setActiveChatTitle("");
      setActiveProjectSlug(null);
      setActiveMemoryProject(null);
      setPage("chat");
      setMobileOpen(false);
      return;
    }
    try {
      const data = await c.call<{ chat: { id: string; projectSlug: string | null; title: string; updatedMs: number; createdMs: number; kind?: ChatKind } }>(
        "clawhq.chats.create",
        {
          kind: "head",
          title: "Head Oswald",
          ...(getFastModeDefault() ? { mode: "fast" } : {}),
        },
      );
      setRecentChats((prev) => [
        {
          id: data.chat.id,
          projectSlug: null,
          title: data.chat.title,
          updatedMs: data.chat.updatedMs,
          messageCount: 0,
          kind: "head",
        },
        ...prev,
      ]);
      setActiveChatId(data.chat.id);
      setActiveChatProject(null);
      setActiveChatKind("head");
      setActiveChatTitle("");
      setActiveProjectSlug(null);
      setActiveMemoryProject(null);
      setPage("chat");
      setMobileOpen(false);
    } catch (err) {
      console.warn("Head Oswald chat create failed:", err);
    }
  }, [status.kind]);

  /**
   * Archive the current chat and route the user to a fresh chat for the
   * same project. Wired from ChatDetailView's large-chat banner. The
   * archived chat stays on disk (so it's browsable from the per-project
   * Archive section) but disappears from the active chat list.
   */
  const handleArchiveAndStartFresh = useCallback(async (chatId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const target = recentChatsRef.current.find((chat) => chat.id === chatId);
    if (!target) return;
    try {
      await c.call("clawhq.chats.archive", { chatId, archived: true });
    } catch (err) {
      console.warn("clawhq.chats.archive failed:", err);
      return;
    }
    type CreatedChat = {
      id: string;
      projectSlug: string | null;
      title: string;
      updatedMs: number;
      createdMs: number;
      kind?: ChatKind;
    };
    let newChat: CreatedChat | null = null;
    try {
      const createPayload: { projectSlug?: string | null; title?: string; kind?: "head"; mode?: "fast" } = {};
      if (target.kind === "head") {
        createPayload.kind = "head";
      } else {
        createPayload.projectSlug = target.projectSlug;
      }
      if (getFastModeDefault()) createPayload.mode = "fast";
      const data = await c.call<{ chat: CreatedChat }>(
        "clawhq.chats.create",
        createPayload,
      );
      newChat = data.chat;
    } catch (err) {
      console.warn("clawhq.chats.create (post-archive) failed:", err);
      return;
    }
    if (!newChat) return;
    // Strip the archived chat from recent + prepend the new one. The
    // server-side broadcast (plugin.clawhq.chat.archived) would also
    // reach us, but local update is faster.
    setRecentChats((prev) => {
      const cleaned = prev.filter((c2) => c2.id !== chatId);
      return [
        {
          id: newChat!.id,
          projectSlug: newChat!.projectSlug,
          title: newChat!.title,
          updatedMs: newChat!.updatedMs,
          messageCount: 0,
          ...(newChat!.kind ? { kind: newChat!.kind } : {}),
        },
        ...cleaned,
      ];
    });
    setActiveChatId(newChat.id);
    setActiveChatProject(newChat.projectSlug);
    setActiveChatKind(newChat.kind ?? "project");
    setActiveChatTitle(newChat.title);
  }, []);

  const handlePickProject = useCallback((slug: string) => {
    setActiveProjectSlug(slug);
    setActiveProjectSub(null);
    setActiveChatId(null);
    setActiveChatProject(null);
    setActiveChatKind(undefined);
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
    setActiveChatKind(undefined);
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
    setActiveChatKind(undefined);
    setActiveChatTitle("");
    setPage("chat");
  }, []);

  const handlePickWorkspaceMemory = useCallback(() => {
    setActiveWorkspaceMemory(true);
    setActiveMemoryProject(null);
    setActiveProjectSlug(null);
    setActiveChatId(null);
    setActiveChatProject(null);
    setActiveChatKind(undefined);
    setActiveChatTitle("");
    setPage("chat");
  }, []);

  const handleChatTitle = useCallback((id: string, title: string) => {
    setActiveChatTitle((prev) => (id === activeChatId ? title : prev));
  }, [activeChatId]);

  const handleChatDeleted = useCallback((deletedId: string) => {
    setActiveChatId((curr) => (curr === deletedId ? null : curr));
    setActiveChatProject((curr) => (activeChatId === deletedId ? null : curr));
    setActiveChatKind((curr) => (activeChatId === deletedId ? undefined : curr));
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

  // ------------------------------------------------------------------
  // Recent chats + per-chat status dots.
  //
  // Recent list = user-facing chat records from clawhq.chats.list, sorted
  // by updatedMs desc. Replaces what used to be sessions.list (which
  // mixed in raw OpenClaw runtime keys).
  //
  // chatStatuses: chatId → "running" (orange) | "done" (green).
  //   - "running" is set in ChatDetailView.sendMessage via onChatStatus.
  //   - "done" is set here by the global chat-event listener when
  //     state==="final" arrives for a clawhq-pattern sessionKey.
  //   - Status persists across chat switches so the sidebar dot survives
  //     navigating away mid-run.
  // ------------------------------------------------------------------
  const handleChatStatus = useCallback((chatId: string, status: ChatStatus) => {
    setChatStatuses((prev) => {
      if (prev.get(chatId) === status) return prev;
      const next = new Map(prev);
      next.set(chatId, status);
      return next;
    });
  }, []);

  useEffect(() => {
    if (status.kind !== "ready" || !clientRef.current) return;
    const c = clientRef.current;
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await c.call<{ chats?: ChatRecentSummary[] }>(
          "clawhq.chats.list",
          {},
        );
        if (cancelled) return;
        const list = (result.chats ?? []).slice().sort(
          (a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0),
        );
        setRecentChats(list);
      } catch (err) {
        // Plugin may not be loaded yet — keep last known list.
        console.warn("clawhq.chats.list failed:", err);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [status.kind]);

  // Drain a /chat-detail/<prefix> deep link once chats are loaded.
  useEffect(() => {
    if (!pendingChatPrefix || recentChats.length === 0) return;
    const chat = recentChats.find((c) => c.id.startsWith(pendingChatPrefix));
    if (chat) {
      setActiveChatId(chat.id);
      setActiveChatProject(chat.projectSlug);
      setActiveChatKind(chat.kind);
      setActiveProjectSlug(null);
      setActiveMemoryProject(null);
      setActiveWorkspaceMemory(false);
      setPage("chat");
    }
    setPendingChatPrefix(null);
  }, [pendingChatPrefix, recentChats]);

  // Global chat-event listener — handles two things for every clawhq-backed
  // session emitting state==="final":
  //   1. Persist the assistant message to its chat file via clawhq.chats.append.
  //      Lives here (NOT in per-chat ChatDetailView) so the persist runs even
  //      when the user has navigated away. Previously the chat-detail
  //      component owned this — switching to another chat mid-response
  //      caused the reply to land at the relay with no listener to save it,
  //      and the relay's safety-net only fires when zero SPA clients are
  //      connected. End result: dropped replies on chat-switch.
  //   2. Set the sidebar dot to "done" so the user sees a result indicator
  //      even when not viewing that chat.
  // Archive/restore broadcast — keep recentChats in sync. The Sidebar has
  // its own listener for projectChats/projectArchivedChats; recentChats
  // lives here in ChatApp so it needs an independent reactor. Without
  // this, an archived chat would linger in the Recent group until reload.
  useEffect(() => {
    if (!clientRef.current) return;
    const c = clientRef.current;
    return c.onEvent((ev: OpenClawEvent) => {
      if (ev.event !== "plugin.clawhq.chat.archived") return;
      const p = (ev.payload ?? {}) as { chatId?: unknown; archived?: unknown };
      if (typeof p.chatId !== "string") return;
      const chatId = p.chatId;
      const archived = p.archived === true;
      if (archived) {
        setRecentChats((prev) => prev.filter((c2) => c2.id !== chatId));
        // If the user is currently viewing the chat being archived from
        // somewhere else, drop them back to no-chat. (Local archive flow
        // already navigates to the fresh chat; this only fires for
        // out-of-band archives — kebab menu, etc.)
        setActiveChatId((curr) => (curr === chatId ? null : curr));
      }
      // Restoration case: the Sidebar will re-fetch projectChats; recent
      // list will repopulate on next chats.list refresh. Not worth a
      // local insert since restore is rare.
    });
  }, []);

  useEffect(() => {
    if (!clientRef.current) return;
    const c = clientRef.current;
    return c.onEvent((ev: OpenClawEvent) => {
      if (ev.event !== "chat") return;
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const state = p.state;
      // All three terminal states need the sidebar dot reset; only `final`
      // takes the persist path here. The relay persists a synthetic ⚠️
      // bubble for error/aborted on its own.
      if (state !== "final" && state !== "error" && state !== "aborted") return;
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : null;
      if (!sessionKey) return;
      const m = sessionKey.match(CLAWHQ_SESSION_PREFIX_RE);
      if (!m || !m[1]) return;
      const prefix = m[1];
      const chat = recentChatsRef.current.find((c2) => c2.id.startsWith(prefix));
      if (!chat) return;
      // Sidebar dot update is safe on every viewer — it's local-only UI.
      handleChatStatus(chat.id, "done");
      if (state !== "final") return;
      // Peer copies skip the persist. Only the originator client writes the
      // assistant-final to chat storage; peers see the row via the
      // plugin.clawhq.chat.message broadcast. The relay also has its own
      // unconditional server-side persist (maybePersistChatTerminal in
      // ws-routing.ts) as a backstop when the originator has navigated
      // away or disconnected mid-run.
      if (ev.viewerRole === "peer") return;
      const messageObj = (p.message ?? null) as Record<string, unknown> | null;
      const role = messageObj && typeof messageObj.role === "string" ? messageObj.role : "";
      if (role !== "assistant" || !messageObj) return;
      const content = contentToText(messageObj.content);
      if (!content) return;
      void c
        .call<{ message?: { id?: string } }>("clawhq.chats.append", {
          chatId: chat.id,
          role: "assistant",
          content,
        })
        .catch((err) => {
          console.warn("global chats.append (assistant final) failed:", err);
        });
    });
  }, [handleChatStatus]);

  // ------------------------------------------------------------------
  // Infinite back stack — every screen-changing state update pushes a
  // snapshot to window.history. Android's back button (MainActivity
  // wv.canGoBack/goBack) and the browser's back gesture both fire
  // popstate, which restores the previous snapshot. When the stack is
  // exhausted, native super.onBackPressed() closes the app.
  //
  // Watched fields are nav-level only: drawer state (mobileOpen), chat
  // title (changes mid-stream), search query, settings sub-tab are all
  // ephemeral and don't push.
  // ------------------------------------------------------------------
  const skipNextPushRef = useRef(true);
  const suppressPushRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const snap = {
      page,
      activeKey,
      activeChatId,
      activeChatProject,
      activeProjectSlug,
      activeProjectSub,
      activeMemoryProject,
      activeWorkspaceMemory,
      showSettings,
      showInbox,
    };
    if (skipNextPushRef.current) {
      skipNextPushRef.current = false;
      try { window.history.replaceState(snap, ""); } catch { /* noop */ }
    } else if (suppressPushRef.current) {
      // This state change came from a popstate event — don't push again.
      suppressPushRef.current = false;
    } else {
      try { window.history.pushState(snap, ""); } catch { /* noop */ }
    }
  }, [
    page, activeKey, activeChatId, activeChatProject,
    activeProjectSlug, activeProjectSub,
    activeMemoryProject, activeWorkspaceMemory,
    showSettings, showInbox,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: PopStateEvent) => {
      const s = e.state as null | {
        page: PageKey;
        activeKey: string | null;
        activeChatId: string | null;
        activeChatProject: string | null;
        activeProjectSlug: string | null;
        activeProjectSub: string | null;
        activeMemoryProject: string | null;
        activeWorkspaceMemory: boolean;
        showSettings: boolean;
        showInbox: boolean;
      };
      if (!s || typeof s.page !== "string") return;
      suppressPushRef.current = true;
      setPage(s.page);
      setActiveKey(s.activeKey);
      setActiveChatId(s.activeChatId);
      setActiveChatProject(s.activeChatProject);
      setActiveProjectSlug(s.activeProjectSlug);
      setActiveProjectSub(s.activeProjectSub);
      setActiveMemoryProject(s.activeMemoryProject);
      setActiveWorkspaceMemory(s.activeWorkspaceMemory);
      setShowSettings(s.showSettings);
      setShowInbox(s.showInbox);
      // Drawer always closes on a back nav so it doesn't linger over the
      // restored screen.
      setMobileOpen(false);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  if (showSettings) {
    return (
      <>
        <Settings
          user={user}
          onClose={() => window.history.back()}
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
            window.history.back();
            // Refresh badge after the user dismisses (they may have marked stuff read).
            void systemApi.notifications(1).then((l) => setUnreadCount(l.unread)).catch(() => {});
          }}
          onOpenDeepLink={(link) => {
            // /chat/<sessionKey> deep links jump to that session. Use back()
            // first so the inbox doesn't sit in the history stack — the chat
            // selection then pushes a fresh entry.
            const m = link.match(/^\/chat\/(.+)$/);
            if (m) {
              window.history.back();
              // Defer so popstate has settled before we push the new selection.
              setTimeout(() => setActiveKey(m[1] ?? null), 0);
            }
          }}
        />
        <SudoGate />
      </>
    );
  }

  // Compact OHQ-style toolbar — bell shrinks to an icon-only button with a
  // small dot when there are unread notifications; the loud "● online" pill
  // becomes a tiny status dot beside the bell. The page-toolbar title row
  // still carries the chat name, so removing the pill text doesn't hide info.
  const toolbar = (
    <button
      className="bell-btn-compact"
      aria-label={unreadCount > 0 ? `${unreadCount} notifications` : "Notifications"}
      onClick={() => setShowInbox(true)}
      title={unreadCount > 0 ? `${unreadCount} unread` : "Notifications"}
    >
      <Bell size={15} />
      {unreadCount > 0 && <span className="bell-dot" aria-hidden="true" />}
    </button>
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
        activeChatKind={activeChatKind}
        onPickChat={handlePickChat}
        onPickHeadOswald={handlePickHeadOswald}
        onChatDeleted={handleChatDeleted}
        activeProjectSlug={activeProjectSlug}
        onPickProject={handlePickProject}
        activeMemoryProject={activeMemoryProject}
        onPickProjectMemory={handlePickProjectMemory}
        activeWorkspaceMemory={activeWorkspaceMemory}
        onPickWorkspaceMemory={handlePickWorkspaceMemory}
        recentChats={recentChats}
        chatStatuses={chatStatuses}
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
        <div className="vitals-strip">
          <span aria-hidden="true" className="vitals-strip-spacer" />
          <SystemHealth />
          <span
            className={`status-dot-only ${pill.cls}`}
            title={pill.label}
            aria-label={pill.label}
          />
        </div>
        <div className="page-toolbar">
          <button
            type="button"
            className="cl-hamburger"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
          ><Menu size={16} /></button>
          <div className="page-toolbar-title">
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
          <div className="page-toolbar-right">{toolbar}</div>
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
                chatKind={activeChatKind}
                status={status}
                chatStatus={chatStatuses.get(activeChatId)}
                onTitleChange={handleChatTitle}
                initialSearchQuery={chatSearchQuery ?? undefined}
                onChatStatus={handleChatStatus}
                onArchiveAndStartFresh={handleArchiveAndStartFresh}
              />
            ) : activeKey ? (
              <ChatPane
                key={activeKey}
                client={clientRef.current}
                sessionKey={activeKey}
                status={status}
              />
            ) : (
              <div className="empty"><div className="big"><Hourglass size={28} /></div>Waiting for session…</div>
            )
          ) : (
            <div className="empty"><div className="big"><Hourglass size={28} /></div>Waiting for session…</div>
          )
        )}
        {page === "sessions" && (
          <SessionsPage
            client={clientRef.current}
            status={status}
            onOpenSession={(k) => { setActiveKey(k); setActiveChatId(null); setActiveChatProject(null); setActiveChatKind(undefined); setPage("chat"); }}
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
        {page === "memory" && <WorkspaceMemoryPage client={clientRef.current} status={status} />}
        {page === "tasks" && <TasksPage client={clientRef.current} status={status} />}
        {page === "home" && (
          <HomePage
            client={clientRef.current}
            status={status}
            onSelectPage={handleSelectPage}
          />
        )}
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
