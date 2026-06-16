import { useCallback, useEffect, useState } from "react";
import { systemApi, type NotificationItem } from "../system-api.js";
import { Bell } from "./icons.js";

interface Props {
  onClose(): void;
  /** Called when a notification with a deep link is tapped. Parent decides how to route. */
  onOpenDeepLink?(link: string): void;
}

export function NotificationsInbox({ onClose, onOpenDeepLink }: Props) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await systemApi.notifications(100);
      setItems(list.notifications);
      setUnread(list.unread);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const handleTap = useCallback(async (n: NotificationItem) => {
    if (!n.readAt) {
      try { await systemApi.markRead(n.id); } catch {}
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: Date.now() } : x)));
      setUnread((u) => Math.max(0, u - 1));
    }
    if (n.deepLink && onOpenDeepLink) onOpenDeepLink(n.deepLink);
  }, [onOpenDeepLink]);

  const handleMarkAll = useCallback(async () => {
    try { await systemApi.markAllRead(); } catch {}
    setItems((prev) => prev.map((x) => (x.readAt ? x : { ...x, readAt: Date.now() })));
    setUnread(0);
  }, []);

  const handleSendTest = useCallback(async () => {
    try {
      await systemApi.sendTestPush({
        title: "Claw HQ test",
        body: `Test fired at ${new Date().toLocaleTimeString()}`,
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [reload]);

  return (
    <div className="settings-shell">
      <div className="settings-header">
        <button className="back-btn" onClick={onClose}>‹ Back</button>
        <div className="title">Notifications{unread > 0 ? ` (${unread})` : ""}</div>
        <div style={{ width: 60 }} />
      </div>

      <div className="settings-body" style={{ paddingTop: 12 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <button className="btn-ghost" onClick={() => void reload()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button className="btn-ghost" onClick={handleMarkAll} disabled={unread === 0}>
            Mark all read
          </button>
          <button className="btn-ghost" onClick={handleSendTest}>
            Send test push
          </button>
        </div>

        {error && <div className="alert error">{error}</div>}

        {!loading && items.length === 0 && (
          <div className="empty"><div className="big"><Bell size={28} /></div>No notifications yet.</div>
        )}

        <ul className="notif-list">
          {items.map((n) => (
            <li
              key={n.id}
              className={`notif-row ${n.readAt ? "read" : "unread"} ${n.deepLink ? "clickable" : ""}`}
              onClick={() => void handleTap(n)}
            >
              <div className="notif-row-main">
                <div className="notif-title">
                  {!n.readAt && <span className="notif-dot" />}
                  {n.title}
                </div>
                <div className="notif-body">{n.body}</div>
              </div>
              <div className="notif-meta">
                <span className="notif-kind">{n.kind}</span>
                <span className="notif-time">{formatWhen(n.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function formatWhen(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
