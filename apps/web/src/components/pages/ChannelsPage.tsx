import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { usePageRpc } from "./usePageRpc.js";
import { Chat } from "../icons.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface ChannelStatus {
  id: string;
  kind?: string;
  label?: string;
  status?: string;
  connected?: boolean;
  detail?: string;
}

/**
 * Wraps OpenClaw's `channels.status` RPC. Power users can manage Slack /
 * Discord / Telegram / etc. integrations from here.
 *
 * The RPC's exact response shape varies between OpenClaw versions; we render
 * leniently from a few common shapes.
 */
export function ChannelsPage({ client, status }: Props) {
  const { data, loading, error, refresh } = usePageRpc<{ channels?: ChannelStatus[]; entries?: ChannelStatus[] }>(
    client,
    status,
    "channels.status",
  );

  const channels = (data?.channels ?? data?.entries ?? []) as ChannelStatus[];

  return (
    <PageShell
      title="Channels"
      subtitle="OpenClaw integrations (Slack, Discord, Telegram, …)"
      actions={<button className="btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>}
    >
      {loading && <div className="empty"><div className="spinner" />Loading…</div>}
      {error && <div className="alert error">{error}</div>}
      {!loading && !error && channels.length === 0 && (
        <div className="empty"><div className="big"><Chat size={28} /></div>No channels reported by OpenClaw.</div>
      )}
      <ul className="page-list">
        {channels.map((c, i) => (
          <li key={c.id ?? i} className="page-row">
            <div className="page-row-main">
              <div className="page-row-title">{c.label ?? c.id ?? "channel"}</div>
              <div className="page-row-subtitle">
                {c.kind && <span className="chip">{c.kind}</span>}
                {c.detail && <span>{c.detail}</span>}
              </div>
            </div>
            <div className="page-row-meta">
              <span className={`status-pill ${c.connected ? "ok" : "warn"}`}>
                <span className="status-dot" />
                {c.status ?? (c.connected ? "connected" : "offline")}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
