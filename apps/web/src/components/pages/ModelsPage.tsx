import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { usePageRpc } from "./usePageRpc.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface ModelEntry {
  id: string;
  provider?: string;
  label?: string;
  contextWindow?: number;
  capabilities?: string[];
  isDefault?: boolean;
}

interface ModelsList {
  models?: ModelEntry[];
  entries?: ModelEntry[];
}

/**
 * models.list — read-only view of every model OpenClaw can route to.
 * Per-session override via sessions.patch lands in v0.5.1 (it needs a session
 * picker; deferred so we ship the catalog first).
 */
export function ModelsPage({ client, status }: Props) {
  const { data, loading, error, refresh } = usePageRpc<ModelsList>(client, status, "models.list");
  const models = (data?.models ?? data?.entries ?? []) as ModelEntry[];

  // Group by provider for legibility.
  const grouped = new Map<string, ModelEntry[]>();
  for (const m of models) {
    const p = m.provider ?? "other";
    if (!grouped.has(p)) grouped.set(p, []);
    grouped.get(p)!.push(m);
  }

  return (
    <PageShell
      title="Models"
      subtitle="Every model OpenClaw can route to, by provider"
      actions={<button className="btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>}
    >
      {loading && <div className="empty"><div className="spinner" />Loading…</div>}
      {error && <div className="alert error">{error}</div>}
      {!loading && !error && models.length === 0 && (
        <div className="empty"><div className="big">🧮</div>No models registered.</div>
      )}
      <div className="mcp-groups">
        {Array.from(grouped.entries()).map(([provider, list]) => (
          <section key={provider} className="mcp-group">
            <header className="mcp-group-header">
              <div className="mcp-group-name">{provider}</div>
              <span className="chip">{list.length}</span>
            </header>
            <ul className="page-list">
              {list.map((m) => (
                <li key={m.id} className="page-row">
                  <div className="page-row-main">
                    <div className="page-row-title">{m.label ?? m.id}</div>
                    <div className="page-row-subtitle">
                      <span className="chip">{m.id}</span>
                      {typeof m.contextWindow === "number" && (
                        <span className="chip">{(m.contextWindow / 1000).toFixed(0)}k ctx</span>
                      )}
                      {m.capabilities?.map((c) => <span key={c} className="chip">{c}</span>)}
                    </div>
                  </div>
                  {m.isDefault && (
                    <div className="page-row-meta">
                      <span className="status-pill ok"><span className="status-dot" />default</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </PageShell>
  );
}
