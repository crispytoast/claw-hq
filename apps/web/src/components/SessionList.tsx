import type { SessionSummary } from "./ChatApp.js";

interface Props {
  sessions: SessionSummary[];
  activeKey: string | null;
  onPick(key: string): void;
}

export function SessionList({ sessions, activeKey, onPick }: Props) {
  if (sessions.length === 0) {
    return <div className="empty" style={{ padding: "1rem", fontSize: "0.85rem" }}>No sessions yet</div>;
  }
  return (
    <div className="session-list">
      {sessions.map((s) => (
        <button
          key={s.sessionKey}
          className={`session-row ${s.sessionKey === activeKey ? "active" : ""}`}
          onClick={() => onPick(s.sessionKey)}
        >
          <span className="label">{s.label}</span>
          <span className="meta">
            {s.model ? `${s.model}` : s.sessionKey}
            {s.lastActivityMs ? ` · ${relativeTime(s.lastActivityMs)}` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

function relativeTime(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}
