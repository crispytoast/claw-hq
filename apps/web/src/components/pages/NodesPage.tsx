import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface NodeRow {
  id: string;
  label?: string;
  name?: string;
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, unknown>;
  connected?: boolean;
  paired?: boolean;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  version?: string;
}

interface NodeListResponse {
  nodes?: NodeRow[];
  rows?: NodeRow[];
  items?: NodeRow[];
}

interface PendingPair {
  id?: string;
  requestId?: string;
  label?: string;
  displayName?: string;
  deviceFamily?: string;
  platform?: string;
  caps?: string[];
  commands?: string[];
  requestedAtMs?: number;
  status?: string;
}

interface PendingResponse {
  requests?: PendingPair[];
  pending?: PendingPair[];
  items?: PendingPair[];
}

function relTime(ms: number | undefined): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  const sec = Math.max(0, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function rowsFrom(resp: NodeListResponse | null): NodeRow[] {
  if (!resp) return [];
  return resp.nodes ?? resp.rows ?? resp.items ?? [];
}

function pendingFrom(resp: PendingResponse | null): PendingPair[] {
  if (!resp) return [];
  return resp.requests ?? resp.pending ?? resp.items ?? [];
}

type ActionState =
  | { kind: "idle" }
  | { kind: "running"; id: string; verb: string }
  | { kind: "error"; id: string; verb: string; message: string };

export function NodesPage({ client, status }: Props) {
  const [nodes, setNodes] = useState<NodeRow[] | null>(null);
  const [pending, setPending] = useState<PendingPair[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pendErr, setPendErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setLoading(true);
    setErr(null);
    setPendErr(null);
    try {
      const r = await client.call<NodeListResponse>("node.list", {});
      setNodes(rowsFrom(r));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    try {
      const r = await client.call<PendingResponse>("node.pair.list", {});
      setPending(pendingFrom(r));
    } catch (e) {
      setPendErr(e instanceof Error ? e.message : String(e));
    }
  }, [client, status.kind]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Mirror lifecycle broadcasts so a phone pairing shows up immediately.
  useEffect(() => {
    if (!client) return;
    return client.onEvent((ev) => {
      if (
        ev.event === "node.pair.requested" ||
        ev.event === "node.pair.resolved" ||
        ev.event === "device.pair.requested" ||
        ev.event === "device.pair.resolved"
      ) {
        void refresh();
      }
    });
  }, [client, refresh]);

  const callMutation = useCallback(
    async (method: string, params: Record<string, unknown>, verb: string, id: string) => {
      if (!client || status.kind !== "ready") return;
      setAction({ kind: "running", verb, id });
      try {
        await client.call(method, params);
        setAction({ kind: "idle" });
        void refresh();
      } catch (e) {
        setAction({
          kind: "error",
          verb,
          id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [client, status.kind, refresh],
  );

  const approve = useCallback(
    (req: PendingPair) => {
      const id = req.requestId ?? req.id;
      if (!id) return;
      void callMutation("node.pair.approve", { requestId: id }, "approve", id);
    },
    [callMutation],
  );

  const reject = useCallback(
    (req: PendingPair) => {
      const id = req.requestId ?? req.id;
      if (!id) return;
      if (!window.confirm(`Reject pairing request from "${req.displayName ?? req.label ?? id}"?`)) return;
      void callMutation("node.pair.reject", { requestId: id }, "reject", id);
    },
    [callMutation],
  );

  const remove = useCallback(
    (node: NodeRow) => {
      if (!window.confirm(`Remove paired node "${node.label ?? node.id}"? It can re-pair later.`)) return;
      void callMutation("node.pair.remove", { id: node.id }, "remove", node.id);
    },
    [callMutation],
  );

  const startRename = useCallback((node: NodeRow) => {
    setRenaming({ id: node.id, value: node.label ?? node.name ?? "" });
  }, []);

  const commitRename = useCallback(() => {
    if (!renaming) return;
    const trimmed = renaming.value.trim();
    if (!trimmed) {
      setRenaming(null);
      return;
    }
    void callMutation("node.rename", { id: renaming.id, label: trimmed }, "rename", renaming.id)
      .finally(() => setRenaming(null));
  }, [renaming, callMutation]);

  const isAdminAttached = status.kind === "ready" && status.scopes.includes("operator.pairing");

  const adminWarning = useMemo(() => {
    if (status.kind !== "ready") return null;
    if (!status.scopes.includes("operator.write")) {
      return "This session does not hold operator.write — most node actions will fail.";
    }
    if (!isAdminAttached) {
      return "Pairing approve/reject requires operator.pairing scope.";
    }
    return null;
  }, [status, isAdminAttached]);

  return (
    <PageShell
      title="Nodes"
      subtitle="Pair a phone or laptop as a camera/mic/canvas/screen node"
      actions={
        <button className="btn-ghost" onClick={() => void refresh()} disabled={loading}>Refresh</button>
      }
    >
      {status.kind !== "ready" && (
        <div className="alert error">Tunnel not ready ({status.kind}). Node management needs an active Gateway session.</div>
      )}
      {adminWarning && status.kind === "ready" && (
        <div className="alert warn">{adminWarning}</div>
      )}

      {action.kind === "error" && (
        <div className="alert error">
          {action.verb} <code>{action.id}</code> failed: {action.message}
          <button
            className="btn-ghost"
            style={{ marginLeft: 8 }}
            onClick={() => setAction({ kind: "idle" })}
          >Dismiss</button>
        </div>
      )}

      <h3 style={{ marginTop: 0 }}>Pending pairing requests</h3>
      {pendErr && <div className="alert error">node.pair.list failed: {pendErr}</div>}
      {!pendErr && pending && pending.length === 0 && (
        <p className="settings-help">
          No pending requests. Start a node host on a device with{" "}
          <code>openclaw node run</code> or open the Claw HQ APK's pairing flow.
        </p>
      )}
      {pending && pending.length > 0 && (
        <ul className="page-list">
          {pending.map((req, i) => {
            const id = req.requestId ?? req.id ?? `pending-${i}`;
            const busy = action.kind === "running" && action.id === id;
            return (
              <li key={id} className="page-row">
                <div className="page-row-main">
                  <div className="page-row-title">
                    {req.displayName ?? req.label ?? id}
                  </div>
                  <div className="page-row-subtitle">
                    <code>{id}</code>
                    {req.platform && <> · {req.platform}</>}
                    {req.deviceFamily && <> · {req.deviceFamily}</>}
                    {req.requestedAtMs && <> · requested {relTime(req.requestedAtMs)}</>}
                  </div>
                  {(req.caps?.length ?? 0) > 0 && (
                    <div className="page-row-subtitle">
                      caps: {(req.caps ?? []).map((c) => <span key={c} className="chip" style={{ marginRight: 4 }}>{c}</span>)}
                    </div>
                  )}
                </div>
                <div className="page-row-meta">
                  <button
                    className="btn-primary"
                    disabled={busy || status.kind !== "ready"}
                    onClick={() => approve(req)}
                  >
                    {busy && action.verb === "approve" ? <span className="spinner" /> : "Approve"}
                  </button>
                  <button
                    className="btn-ghost danger"
                    disabled={busy || status.kind !== "ready"}
                    onClick={() => reject(req)}
                  >
                    {busy && action.verb === "reject" ? <span className="spinner" /> : "Reject"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h3 style={{ marginTop: "2rem" }}>Paired nodes</h3>
      {err && <div className="alert error">node.list failed: {err}</div>}
      {loading && nodes === null && <div className="empty"><div className="spinner" />Loading…</div>}
      {nodes && nodes.length === 0 && !loading && !err && (
        <div className="empty"><div className="big">📱</div>No nodes paired yet.</div>
      )}
      {nodes && nodes.length > 0 && (
        <ul className="page-list">
          {nodes.map((node) => {
            const id = node.id;
            const busy = action.kind === "running" && action.id === id;
            const isRenaming = renaming?.id === id;
            const dotClass = node.connected ? "ok" : node.paired ? "warn" : "bad";
            const dotLabel = node.connected ? "connected" : node.paired ? "paired" : "offline";
            return (
              <li key={id} className="page-row">
                <div className="page-row-main">
                  <div className="page-row-title">
                    {isRenaming ? (
                      <input
                        autoFocus
                        type="text"
                        value={renaming!.value}
                        onChange={(e) => setRenaming({ id, value: e.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                          if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                        }}
                        style={{ minWidth: 200 }}
                      />
                    ) : (
                      <>
                        {node.label ?? node.name ?? id}
                        <button
                          className="btn-ghost"
                          style={{ marginLeft: 6, fontSize: "0.7rem" }}
                          onClick={() => startRename(node)}
                          title="Rename"
                        >✏️</button>
                      </>
                    )}
                  </div>
                  <div className="page-row-subtitle">
                    <code>{id}</code>
                    {node.platform && <> · {node.platform}</>}
                    {node.deviceFamily && <> · {node.deviceFamily}</>}
                    {node.modelIdentifier && <> · {node.modelIdentifier}</>}
                    {" · last seen "}{relTime(node.lastSeenAtMs)}
                    {node.lastSeenReason && <> ({node.lastSeenReason})</>}
                  </div>
                  {(node.caps?.length ?? 0) > 0 && (
                    <div className="page-row-subtitle">
                      caps:{" "}
                      {(node.caps ?? []).map((c) => (
                        <span key={c} className="chip" style={{ marginRight: 4 }}>{c}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="page-row-meta">
                  <span className={`status-pill ${dotClass}`}>
                    <span className="status-dot" />
                    {dotLabel}
                  </span>
                  <button
                    className="btn-ghost danger"
                    disabled={busy || status.kind !== "ready"}
                    onClick={() => remove(node)}
                  >
                    {busy && action.verb === "remove" ? <span className="spinner" /> : "Remove"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <details style={{ marginTop: "2rem" }}>
        <summary style={{ cursor: "pointer", color: "var(--muted-foreground)" }}>
          How do I pair a new node?
        </summary>
        <div className="settings-help" style={{ marginTop: 8 }}>
          <strong>From a laptop:</strong>
          <pre className="tool-block-pre" style={{ marginTop: 4 }}>{`openclaw node run --host <gateway-host> --port 18789 --display-name "My Laptop"`}</pre>
          <strong style={{ marginTop: 12, display: "inline-block" }}>From the Claw HQ APK on a phone:</strong>
          <p style={{ marginTop: 4 }}>
            Open the APK → menu → "Pair as node". The phone will appear in "Pending pairing
            requests" above; tap Approve to grant it camera/canvas access.
          </p>
        </div>
      </details>
    </PageShell>
  );
}
