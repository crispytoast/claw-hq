import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { usePageRpc } from "./usePageRpc.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface Skill {
  id?: string;
  slug?: string;
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

interface SkillStatusEntry {
  slug?: string;
  name?: string;
  installed?: boolean;
  version?: string;
}

interface SkillStatusResponse {
  skills?: SkillStatusEntry[];
  installed?: SkillStatusEntry[];
}

function skillSlug(s: Skill): string | null {
  return s.slug ?? s.id ?? (s.name ? s.name : null);
}

export function SkillsPage({ client, status }: Props) {
  const [query, setQuery] = useState("");
  const { data, loading, error, refresh } = usePageRpc<SkillSearchResponse>(
    client,
    status,
    "skills.search",
    { query },
  );

  /** Per-slug install state — undefined means search-result default. */
  const [installState, setInstallState] = useState<Map<string, "installing" | "installed" | { error: string }>>(new Map());
  /** Slugs reported installed by skills.status. Layered over search results. */
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());

  const refreshStatus = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    try {
      const result = await client.call<SkillStatusResponse>("skills.status", {});
      const list = (result.skills ?? result.installed ?? []) as SkillStatusEntry[];
      const set = new Set<string>();
      for (const entry of list) {
        if (entry.installed === false) continue;
        const slug = entry.slug ?? entry.name;
        if (slug) set.add(slug);
      }
      setInstalledSlugs(set);
    } catch {
      // Status surface unavailable — leave the SkillSearchResponse hint alone.
    }
  }, [client, status.kind]);

  // Pull installed inventory once on mount so the search results know which
  // slugs are already on disk even when the search RPC doesn't fill `installed`.
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleInstall = useCallback(
    async (skill: Skill) => {
      if (!client || status.kind !== "ready") return;
      const slug = skillSlug(skill);
      if (!slug) return;
      setInstallState((m) => new Map(m).set(slug, "installing"));
      try {
        const params: Record<string, unknown> = { source: "clawhub", slug };
        if (skill.version) params.version = skill.version;
        await client.call("skills.install", params);
        setInstallState((m) => new Map(m).set(slug, "installed"));
        // Refresh truth from skills.status so the row mirrors reality.
        void refreshStatus();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setInstallState((m) => new Map(m).set(slug, { error: msg }));
      }
    },
    [client, status.kind, refreshStatus],
  );

  const skills = useMemo(() => {
    return (data?.skills ?? data?.results ?? data?.installed ?? []) as Skill[];
  }, [data]);

  return (
    <PageShell
      title="Skills"
      subtitle="Browse ClawHub skills your OpenClaw can install"
      actions={<button className="btn-ghost" onClick={() => { refresh(); void refreshStatus(); }} disabled={loading}>Refresh</button>}
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
        {skills.map((s, i) => {
          const slug = skillSlug(s);
          const localState = slug ? installState.get(slug) : undefined;
          const isInstalling = localState === "installing";
          const isInstalled = s.installed
            || (slug ? installedSlugs.has(slug) : false)
            || localState === "installed";
          const errorMsg =
            localState && typeof localState === "object" && "error" in localState
              ? localState.error
              : null;
          return (
            <li key={s.id ?? s.slug ?? s.name ?? i} className="page-row">
              <div className="page-row-main">
                <div className="page-row-title">{s.name}</div>
                {s.description && <div className="page-row-subtitle">{s.description}</div>}
                {errorMsg && (
                  <div className="page-row-subtitle skills-install-error" title={errorMsg}>
                    install failed: {errorMsg.length > 100 ? `${errorMsg.slice(0, 97)}…` : errorMsg}
                  </div>
                )}
              </div>
              <div className="page-row-meta">
                {s.version && <span className="chip">{s.version}</span>}
                {isInstalled ? (
                  <span className="status-pill ok"><span className="status-dot" />installed</span>
                ) : isInstalling ? (
                  <button className="btn-primary" disabled>
                    <span className="spinner" /> Installing…
                  </button>
                ) : (
                  <button
                    className="btn-primary"
                    disabled={!slug}
                    onClick={() => void handleInstall(s)}
                  >Install</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </PageShell>
  );
}
