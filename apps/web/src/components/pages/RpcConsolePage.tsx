import { useCallback, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

/**
 * Universal escape hatch: invoke any OpenClaw RPC by name with JSON params,
 * see the raw response. Used for: methods that don't have a polished page
 * yet (Cron, Memory, Plugins, Config, Nodes), debugging, and power-user flows.
 */
export function RpcConsolePage({ client, status }: Props) {
  const [method, setMethod] = useState("sessions.list");
  const [params, setParams] = useState("{}");
  const [response, setResponse] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    if (!client) {
      setError("Gateway client not ready.");
      return;
    }
    if (status.kind !== "ready") {
      setError(`Gateway not ready (${status.kind}).`);
      return;
    }
    let parsed: unknown = {};
    try { parsed = params.trim() === "" ? {} : JSON.parse(params); }
    catch (err) {
      setError(`params is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setBusy(true);
    setError(null);
    setResponse("");
    try {
      const data = await client.call(method, parsed);
      setResponse(JSON.stringify(data, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [client, status.kind, method, params]);

  return (
    <PageShell
      title="RPC Console"
      subtitle="Invoke any OpenClaw Gateway method directly"
    >
      <div className="rpc-console">
        <label className="field">
          <span>Method</span>
          <input
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            placeholder="e.g. sessions.list, channels.status, cron.list, models.list"
          />
        </label>
        <label className="field">
          <span>Params (JSON)</span>
          <textarea
            value={params}
            onChange={(e) => setParams(e.target.value)}
            rows={6}
            placeholder="{}"
          />
        </label>
        <div className="row">
          <button className="btn-primary" onClick={() => void run()} disabled={busy}>
            {busy ? "Calling…" : "Call"}
          </button>
        </div>
        {error && <div className="alert error">{error}</div>}
        {response && (
          <>
            <h3 className="section-title">Response</h3>
            <pre className="code-block large">{response}</pre>
          </>
        )}
        <details className="rpc-quick-actions">
          <summary>Quick references</summary>
          <ul className="page-list">
            <li className="page-row"><div className="page-row-main">
              <div className="page-row-title">Channels</div>
              <code className="page-row-subtitle">channels.status</code>
            </div></li>
            <li className="page-row"><div className="page-row-main">
              <div className="page-row-title">Cron</div>
              <code className="page-row-subtitle">cron.list / cron.add / cron.remove / cron.run</code>
            </div></li>
            <li className="page-row"><div className="page-row-main">
              <div className="page-row-title">Memory</div>
              <code className="page-row-subtitle">memory.list / memory.read / memory.write</code>
            </div></li>
            <li className="page-row"><div className="page-row-main">
              <div className="page-row-title">Plugins</div>
              <code className="page-row-subtitle">plugins.list / plugins.install</code>
            </div></li>
            <li className="page-row"><div className="page-row-main">
              <div className="page-row-title">Config</div>
              <code className="page-row-subtitle">config.get / config.set / config.schema</code>
            </div></li>
            <li className="page-row"><div className="page-row-main">
              <div className="page-row-title">Nodes</div>
              <code className="page-row-subtitle">node.list / node.pair.start / node.invoke</code>
            </div></li>
          </ul>
        </details>
      </div>
    </PageShell>
  );
}
