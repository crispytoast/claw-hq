import { useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { usePageRpc } from "./usePageRpc.js";
import { Tools } from "../icons.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface ToolEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
  source?: string; // mcp server name
}

interface ToolCatalog {
  tools?: ToolEntry[];
  servers?: Array<{ name: string; status?: string; toolCount?: number }>;
  byServer?: Record<string, ToolEntry[]>;
}

/**
 * `tools.catalog` — every tool the agent has access to, grouped by source MCP.
 * Each tool can be expanded to see its description + input schema.
 */
export function McpsPage({ client, status }: Props) {
  const { data, loading, error, refresh } = usePageRpc<ToolCatalog>(client, status, "tools.catalog");
  const [expanded, setExpanded] = useState<string | null>(null);

  const grouped = groupTools(data);

  return (
    <PageShell
      title="MCPs & Tools"
      subtitle="Every tool the agent can call, grouped by source"
      actions={<button className="btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>}
    >
      {loading && <div className="empty"><div className="spinner" />Loading…</div>}
      {error && <div className="alert error">{error}</div>}
      {!loading && !error && grouped.length === 0 && (
        <div className="empty"><div className="big"><Tools size={28} /></div>No tools cataloged.</div>
      )}
      <div className="mcp-groups">
        {grouped.map((g) => (
          <section key={g.server} className="mcp-group">
            <header className="mcp-group-header">
              <div className="mcp-group-name">{g.server}</div>
              <span className="chip">{g.tools.length} tools</span>
            </header>
            <ul className="page-list">
              {g.tools.map((t) => {
                const id = `${g.server}::${t.name}`;
                const isOpen = expanded === id;
                return (
                  <li
                    key={id}
                    className={`page-row clickable ${isOpen ? "expanded" : ""}`}
                    onClick={() => setExpanded(isOpen ? null : id)}
                  >
                    <div className="page-row-main">
                      <div className="page-row-title">{t.name}</div>
                      {t.description && (
                        <div className="page-row-subtitle">{t.description}</div>
                      )}
                      {isOpen && t.inputSchema !== undefined && (
                        <pre className="code-block">{JSON.stringify(t.inputSchema, null, 2)}</pre>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </PageShell>
  );
}

function groupTools(catalog: ToolCatalog | null): Array<{ server: string; tools: ToolEntry[] }> {
  if (!catalog) return [];
  if (catalog.byServer) {
    return Object.entries(catalog.byServer).map(([server, tools]) => ({ server, tools }));
  }
  if (Array.isArray(catalog.tools)) {
    const buckets = new Map<string, ToolEntry[]>();
    for (const t of catalog.tools) {
      const server = t.source ?? "builtin";
      if (!buckets.has(server)) buckets.set(server, []);
      buckets.get(server)!.push(t);
    }
    return Array.from(buckets.entries()).map(([server, tools]) => ({ server, tools }));
  }
  return [];
}
