import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";

interface PluginEntry {
  id: string;
  enabled: boolean;
  version?: string;
  description?: string;
  source?: string;
  origin?: string;
  installPath?: string;
}

interface ListResult {
  plugins: PluginEntry[];
}

interface SearchHit {
  id: string;
  name?: string;
  channel?: string;
  family?: string;
  version?: string;
  summary?: string;
  installHint?: string;
}

interface SearchResult {
  hits: SearchHit[];
}

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

type ActionState =
  | { kind: "idle" }
  | { kind: "running"; verb: "install" | "uninstall"; id: string }
  | { kind: "ok"; verb: "install" | "uninstall"; id: string }
  | { kind: "error"; verb: "install" | "uninstall"; id: string; message: string };

export function SettingsPluginsTab({ client, status }: Props) {
  const [plugins, setPlugins] = useState<PluginEntry[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listing, setListing] = useState(true);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [installSpec, setInstallSpec] = useState("");

  const refreshList = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setListing(true);
    setListErr(null);
    try {
      const result = await client.call<ListResult>("clawhq.plugins.list", {});
      setPlugins(result.plugins ?? []);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : String(e));
    } finally {
      setListing(false);
    }
  }, [client, status.kind]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  // React to install/uninstall broadcasts so two devices stay in sync.
  useEffect(() => {
    if (!client) return;
    return client.onEvent((ev) => {
      if (ev.event === "plugin.clawhq.plugins.changed") void refreshList();
    });
  }, [client, refreshList]);

  const runSearch = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    const q = query.trim();
    if (!q) {
      setHits(null);
      setSearchErr(null);
      return;
    }
    setSearching(true);
    setSearchErr(null);
    try {
      const result = await client.call<SearchResult>("clawhq.plugins.search", { query: q });
      setHits(result.hits ?? []);
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }, [client, status.kind, query]);

  const install = useCallback(
    async (spec: string) => {
      if (!client || status.kind !== "ready" || !spec) return;
      setAction({ kind: "running", verb: "install", id: spec });
      try {
        await client.call("clawhq.plugins.install", { spec });
        setAction({ kind: "ok", verb: "install", id: spec });
        setInstallSpec("");
        void refreshList();
      } catch (e) {
        setAction({
          kind: "error",
          verb: "install",
          id: spec,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [client, status.kind, refreshList],
  );

  const uninstall = useCallback(
    async (id: string) => {
      if (!client || status.kind !== "ready") return;
      if (!window.confirm(
        `Uninstall plugin "${id}"? This runs \`openclaw plugins uninstall\` on the host.`,
      )) return;
      setAction({ kind: "running", verb: "uninstall", id });
      try {
        await client.call("clawhq.plugins.uninstall", { id });
        setAction({ kind: "ok", verb: "uninstall", id });
        void refreshList();
      } catch (e) {
        setAction({
          kind: "error",
          verb: "uninstall",
          id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [client, status.kind, refreshList],
  );

  const installedIds = useMemo(() => {
    if (!plugins) return new Set<string>();
    return new Set(plugins.map((p) => p.id));
  }, [plugins]);

  const isAdminAttached = status.kind === "ready" && status.scopes.includes("operator.admin");

  return (
    <div className="settings-pane">
      <h2>Installed plugins</h2>
      <p className="settings-help">
        Live inventory from this OpenClaw's <code>plugins list</code>. Install or uninstall mutates
        the host file system via <code>openclaw plugins install / uninstall</code> and may take a
        moment.
      </p>

      {status.kind !== "ready" && (
        <div className="settings-err">
          Tunnel not ready ({status.kind}). Plugin management needs an active Gateway session.
        </div>
      )}

      {!isAdminAttached && status.kind === "ready" && (
        <div className="settings-help" style={{ color: "#d4a017" }}>
          This session doesn't hold <code>operator.admin</code>; install/uninstall will fail.
        </div>
      )}

      {action.kind === "ok" && (
        <div className="settings-card pairing-issued">
          {action.verb === "install" ? "Installed" : "Uninstalled"} <code>{action.id}</code> ✓
          <div style={{ marginTop: 6 }}>
            <button className="btn-ghost" onClick={() => setAction({ kind: "idle" })}>Dismiss</button>
          </div>
        </div>
      )}
      {action.kind === "error" && (
        <div className="settings-err">
          {action.verb === "install" ? "Install" : "Uninstall"} <code>{action.id}</code> failed: {action.message}
          <div style={{ marginTop: 6 }}>
            <button className="btn-ghost" onClick={() => setAction({ kind: "idle" })}>Dismiss</button>
          </div>
        </div>
      )}

      <div className="settings-card">
        <div className="settings-card-title">Install by spec</div>
        <p className="settings-help" style={{ marginBottom: 8 }}>
          Examples: <code>clawhub:owner/name</code>, <code>npm:@scope/package</code>,
          {" "}<code>./local/path</code>
        </p>
        <div className="pairing-issue-row">
          <input
            type="text"
            placeholder="plugin id or spec…"
            value={installSpec}
            onChange={(e) => setInstallSpec(e.target.value)}
            disabled={action.kind === "running"}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void install(installSpec.trim());
              }
            }}
          />
          <button
            className="btn-primary"
            onClick={() => void install(installSpec.trim())}
            disabled={!installSpec.trim() || action.kind === "running" || status.kind !== "ready"}
          >
            {action.kind === "running" && action.verb === "install"
              ? <span className="spinner" />
              : "Install"}
          </button>
        </div>
      </div>

      {listErr && <div className="settings-err">List failed: {listErr}</div>}

      <h3 style={{ marginTop: "1.5rem" }}>Active</h3>
      {listing && plugins === null && <div className="spinner" />}
      {!listing && plugins && plugins.length === 0 && (
        <p className="settings-help">No plugins installed.</p>
      )}
      {plugins && plugins.length > 0 && (
        <ul className="pairing-list">
          {plugins.map((p) => {
            const busy = action.kind === "running" && action.id === p.id;
            return (
              <li key={p.id} className="pairing-row">
                <div className="pairing-row-main">
                  <div className="pairing-row-title">
                    {p.id}
                    {p.version && <span className="chip" style={{ marginLeft: 6 }}>{p.version}</span>}
                    {!p.enabled && (
                      <span className="chip" style={{ marginLeft: 6, background: "rgba(212,160,23,0.18)", color: "#d4a017" }}>
                        disabled
                      </span>
                    )}
                  </div>
                  <div className="pairing-row-sub">
                    {p.description ?? "(no description)"}
                    {p.source && <> · source: <code>{p.source}</code></>}
                    {p.origin && <> · {p.origin}</>}
                  </div>
                </div>
                <button
                  className="btn-ghost danger"
                  disabled={busy || status.kind !== "ready"}
                  onClick={() => void uninstall(p.id)}
                >
                  {busy ? <span className="spinner" /> : "Uninstall"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <h3 style={{ marginTop: "1.5rem" }}>Search ClawHub</h3>
      <div className="search-row">
        <input
          type="search"
          placeholder="Search plugins…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void runSearch(); } }}
        />
        <button className="btn-ghost" onClick={() => void runSearch()} disabled={searching || status.kind !== "ready"}>
          {searching ? <span className="spinner" /> : "Search"}
        </button>
      </div>
      {searchErr && <div className="settings-err">{searchErr}</div>}
      {hits && hits.length === 0 && !searching && (
        <p className="settings-help">No results for "{query}".</p>
      )}
      {hits && hits.length > 0 && (
        <ul className="pairing-list">
          {hits.map((h) => {
            const installed = installedIds.has(h.id);
            const busy = action.kind === "running" && action.id === h.id;
            return (
              <li key={h.id} className="pairing-row">
                <div className="pairing-row-main">
                  <div className="pairing-row-title">
                    {h.name ?? h.id}
                    {h.version && <span className="chip" style={{ marginLeft: 6 }}>{h.version}</span>}
                    {h.channel && (
                      <span className="chip" style={{ marginLeft: 6 }}>{h.channel}</span>
                    )}
                  </div>
                  <div className="pairing-row-sub">
                    <code>{h.id}</code>
                    {h.summary && <> · {h.summary}</>}
                  </div>
                </div>
                {installed ? (
                  <span className="status-pill ok"><span className="status-dot" />installed</span>
                ) : (
                  <button
                    className="btn-primary"
                    disabled={busy || status.kind !== "ready"}
                    onClick={() => void install(h.id)}
                  >
                    {busy ? <span className="spinner" /> : "Install"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
