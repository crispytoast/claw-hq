import { useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { usePageRpc } from "./usePageRpc.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface Skill {
  id?: string;
  name: string;
  description?: string;
  version?: string;
  installed?: boolean;
}

interface SkillSearchResponse {
  skills?: Skill[];
  results?: Skill[];
  installed?: Skill[];
}

/**
 * Browse + install OpenClaw skills (from ClawHub).
 * Read-only for v0.5.0; install actions queued for v0.5.1 once we confirm
 * the `skills.install` RPC's params.
 */
export function SkillsPage({ client, status }: Props) {
  const [query, setQuery] = useState("");
  const { data, loading, error, refresh } = usePageRpc<SkillSearchResponse>(
    client,
    status,
    "skills.search",
    { query },
  );

  const skills = (data?.skills ?? data?.results ?? data?.installed ?? []) as Skill[];

  return (
    <PageShell
      title="Skills"
      subtitle="Browse ClawHub skills your OpenClaw can install"
      actions={<button className="btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>}
    >
      <div className="search-row">
        <input
          type="search"
          placeholder="Search skills…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {loading && <div className="empty"><div className="spinner" />Loading…</div>}
      {error && <div className="alert error">{error}</div>}
      {!loading && !error && skills.length === 0 && (
        <div className="empty"><div className="big">🧠</div>No skills found.</div>
      )}
      <ul className="page-list">
        {skills.map((s, i) => (
          <li key={s.id ?? s.name ?? i} className="page-row">
            <div className="page-row-main">
              <div className="page-row-title">{s.name}</div>
              {s.description && <div className="page-row-subtitle">{s.description}</div>}
            </div>
            <div className="page-row-meta">
              {s.version && <span className="chip">{s.version}</span>}
              {s.installed && <span className="status-pill ok"><span className="status-dot" />installed</span>}
            </div>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
