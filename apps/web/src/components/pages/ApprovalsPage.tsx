import { useCallback, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { usePageRpc } from "./usePageRpc.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface Approval {
  id: string;
  command?: string;
  cwd?: string;
  reason?: string;
  requestedAt?: number;
  sessionKey?: string;
}

interface ApprovalsList {
  approvals?: Approval[];
  pending?: Approval[];
}

/**
 * Pending exec approvals queue. Tap Approve / Deny → `exec.approval.resolve`
 * with `{id, allow: bool}`. Same pattern used by FCM-driven push approvals
 * but available in-app for users without a phone.
 */
export function ApprovalsPage({ client, status }: Props) {
  const { data, loading, error, refresh } = usePageRpc<ApprovalsList>(client, status, "exec.approval.list");
  const [busy, setBusy] = useState<string | null>(null);

  const approvals = (data?.approvals ?? data?.pending ?? []) as Approval[];

  const resolve = useCallback(async (id: string, allow: boolean) => {
    if (!client) return;
    setBusy(id);
    try {
      await client.call("exec.approval.resolve", { id, allow });
      refresh();
    } catch (err) {
      window.alert(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }, [client, refresh]);

  return (
    <PageShell
      title="Approvals"
      subtitle="Commands waiting for human go-ahead"
      actions={<button className="btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>}
    >
      {loading && <div className="empty"><div className="spinner" />Loading…</div>}
      {error && <div className="alert error">{error}</div>}
      {!loading && !error && approvals.length === 0 && (
        <div className="empty"><div className="big">✅</div>No approvals pending.</div>
      )}
      <ul className="page-list">
        {approvals.map((a) => (
          <li key={a.id} className="page-row vertical">
            <div className="page-row-main">
              <div className="page-row-title approval-cmd">{a.command ?? a.id}</div>
              {a.cwd && <div className="page-row-subtitle">cwd: <code>{a.cwd}</code></div>}
              {a.reason && <div className="page-row-subtitle">{a.reason}</div>}
              {a.requestedAt && (
                <div className="page-row-subtitle">
                  requested {new Date(a.requestedAt).toLocaleString()}
                </div>
              )}
            </div>
            <div className="page-row-meta wide">
              <button
                className="btn-primary"
                disabled={busy === a.id}
                onClick={() => void resolve(a.id, true)}
              >Approve</button>
              <button
                className="btn-ghost danger"
                disabled={busy === a.id}
                onClick={() => void resolve(a.id, false)}
              >Deny</button>
            </div>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
