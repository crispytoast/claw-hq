import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type User } from "../api.js";
import { GatewayClient, defaultGatewayUrl, type ConnectionStatus } from "../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";
import { ChatPane } from "./ChatPane.js";
import { SessionList } from "./SessionList.js";
import { Settings } from "./Settings.js";

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
  const [showSidebar, setShowSidebar] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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

  // Mobile UX: when picking a session, hide the sidebar.
  const handlePickSession = useCallback((key: string) => {
    setActiveKey(key);
    if (window.matchMedia("(max-width: 720px)").matches) setShowSidebar(false);
  }, []);

  // Close menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const handler = () => setMenuOpen(false);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [menuOpen]);

  const pill = useMemo(() => statusPill(status), [status]);

  if (showSettings) {
    return <Settings user={user} onClose={() => setShowSettings(false)} />;
  }

  return (
    <div className={`chat-shell ${showSidebar ? "show-sidebar" : ""}`}>
      <aside className="chat-sidebar">
        <div className="sidebar-header" style={{ position: "relative" }}>
          <div className="title">
            <span className="brand-dot" />
            Claw HQ
          </div>
          <button
            className="menu"
            aria-label="menu"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >⋯</button>
          {menuOpen && (
            <div className="menu-popover">
              <button onClick={() => { setMenuOpen(false); setShowSettings(true); }}>Settings</button>
              <div className="sep" />
              <button onClick={async () => {
                const tokens = await api.listPairingTokens();
                alert(`Paired devices:\n${tokens.map((t) => `• ${t.label} — last used ${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}`).join("\n") || "(none)"}`);
              }}>Paired devices</button>
              <div className="sep" />
              <button onClick={onLogout}>Log out ({user.displayName})</button>
            </div>
          )}
        </div>

        <SessionList
          sessions={sessions}
          activeKey={activeKey}
          onPick={handlePickSession}
        />

        <div className="sidebar-footer">
          <span>{user.displayName}</span>
          <span className={`status-pill ${pill.cls}`}>
            <span className="status-dot" />
            {pill.label}
          </span>
        </div>
      </aside>

      <main className="chat-main">
        <div className="chat-header">
          <button className="back-btn" onClick={() => setShowSidebar(true)}>‹ Back</button>
          <div className="title">
            {sessions.find((s) => s.sessionKey === activeKey)?.label ?? "No session"}
          </div>
          <span className={`status-pill ${pill.cls}`}>
            <span className="status-dot" />
            {pill.label}
          </span>
        </div>

        {clientRef.current && activeKey ? (
          <ChatPane
            key={activeKey}
            client={clientRef.current}
            sessionKey={activeKey}
            status={status}
          />
        ) : (
          <div className="empty"><div className="big">⏳</div>Waiting for session…</div>
        )}
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
