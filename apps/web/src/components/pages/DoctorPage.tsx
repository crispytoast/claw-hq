import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { usePageRpc } from "./usePageRpc.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface HealthReport {
  status?: string;
  components?: Array<{ id: string; status: string; detail?: string }>;
  warnings?: Array<{ id: string; message: string }>;
  errors?: Array<{ id: string; message: string }>;
}

/**
 * `health` + (best-effort) `diagnostics.stability` view. Surfaces every
 * component OpenClaw reports a status for, with color-coded pills.
 */
export function DoctorPage({ client, status }: Props) {
  const { data, loading, error, refresh } = usePageRpc<HealthReport>(client, status, "health");

  const components = data?.components ?? [];

  return (
    <PageShell
      title="Doctor"
      subtitle="System health from OpenClaw"
      actions={<button className="btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>}
    >
      {loading && <div className="empty"><div className="spinner" />Loading…</div>}
      {error && <div className="alert error">{error}</div>}
      {!loading && !error && (
        <>
          {data?.status && (
            <div className="overall-health">
              <span className={`status-pill ${healthClass(data.status)}`}>
                <span className="status-dot" />
                overall: {data.status}
              </span>
            </div>
          )}
          {components.length === 0 && data?.status === undefined && (
            <div className="empty"><div className="big">🩺</div>No diagnostic data.</div>
          )}
          <ul className="page-list">
            {components.map((c) => (
              <li key={c.id} className="page-row">
                <div className="page-row-main">
                  <div className="page-row-title">{c.id}</div>
                  {c.detail && <div className="page-row-subtitle">{c.detail}</div>}
                </div>
                <div className="page-row-meta">
                  <span className={`status-pill ${healthClass(c.status)}`}>
                    <span className="status-dot" />
                    {c.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {(data?.warnings ?? []).length > 0 && (
            <>
              <h3 className="section-title">Warnings</h3>
              <ul className="page-list">
                {data!.warnings!.map((w) => (
                  <li key={w.id} className="page-row">
                    <div className="page-row-main">
                      <div className="page-row-title">{w.id}</div>
                      <div className="page-row-subtitle">{w.message}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {(data?.errors ?? []).length > 0 && (
            <>
              <h3 className="section-title">Errors</h3>
              <ul className="page-list">
                {data!.errors!.map((w) => (
                  <li key={w.id} className="page-row">
                    <div className="page-row-main">
                      <div className="page-row-title">{w.id}</div>
                      <div className="page-row-subtitle">{w.message}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </PageShell>
  );
}

function healthClass(s: string): string {
  const l = s.toLowerCase();
  if (l.includes("ok") || l.includes("healthy") || l.includes("ready") || l === "up") return "ok";
  if (l.includes("warn") || l.includes("degraded")) return "warn";
  return "bad";
}
