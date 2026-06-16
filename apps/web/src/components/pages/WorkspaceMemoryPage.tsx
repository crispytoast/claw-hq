import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface MemoryFileSummary {
  name: string;
  size: number;
  updatedMs: number;
}

interface MemoryFileContent extends MemoryFileSummary {
  content: string;
}

interface ListResponse {
  projectSlug: string | null;
  files: MemoryFileSummary[];
}

interface GetResponse {
  projectSlug: string | null;
  file: MemoryFileContent;
}

interface LongTermResponse {
  exists: boolean;
  file?: { content: string; size: number; updatedMs: number };
}

interface DailyEntry {
  date: string;
  file: MemoryFileSummary;
}

const DATE_FILENAME = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
const LONG_TERM_SENTINEL = "__long_term__";

function parseDateEntries(files: MemoryFileSummary[]): {
  daily: DailyEntry[];
  other: MemoryFileSummary[];
} {
  const daily: DailyEntry[] = [];
  const other: MemoryFileSummary[] = [];
  for (const f of files) {
    const m = f.name.match(DATE_FILENAME);
    if (m) {
      daily.push({ date: `${m[1]}-${m[2]}-${m[3]}`, file: f });
    } else {
      other.push(f);
    }
  }
  // Sorted newest-first by date string (YYYY-MM-DD is lexicographically sortable).
  daily.sort((a, b) => b.date.localeCompare(a.date));
  other.sort((a, b) => a.name.localeCompare(b.name));
  return { daily, other };
}

function groupByMonth(daily: DailyEntry[]): Array<{ month: string; entries: DailyEntry[] }> {
  const map = new Map<string, DailyEntry[]>();
  for (const e of daily) {
    const month = e.date.slice(0, 7); // YYYY-MM
    const bucket = map.get(month);
    if (bucket) bucket.push(e);
    else map.set(month, [e]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, entries]) => ({ month, entries }));
}

function formatMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  if (!y || !m) return yyyymm;
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

function formatDate(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split("-");
  if (!y || !m || !d) return yyyymmdd;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function WorkspaceMemoryPage({ client, status }: Props) {
  const [files, setFiles] = useState<MemoryFileSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [longTerm, setLongTerm] = useState<{ content: string; size: number; updatedMs: number } | null>(null);
  const [longTermMissing, setLongTermMissing] = useState(false);
  const [longTermError, setLongTermError] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(LONG_TERM_SENTINEL);
  const [activeContent, setActiveContent] = useState<string>("");
  const [activeMeta, setActiveMeta] = useState<{ size: number; updatedMs: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const loadList = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setListError(null);
    try {
      const res = await client.call<ListResponse>("clawhq.memory.list", {});
      setFiles(res.files);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setFiles([]);
    }
  }, [client, status.kind]);

  const loadLongTerm = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setLongTermError(null);
    try {
      const res = await client.call<LongTermResponse>("clawhq.memory.longTerm", {});
      if (!res.exists) {
        setLongTermMissing(true);
        setLongTerm(null);
      } else if (res.file) {
        setLongTermMissing(false);
        setLongTerm(res.file);
      }
    } catch (err) {
      setLongTermError(err instanceof Error ? err.message : String(err));
    }
  }, [client, status.kind]);

  const loadFile = useCallback(
    async (name: string) => {
      if (!client || status.kind !== "ready") return;
      setLoadError(null);
      try {
        const res = await client.call<GetResponse>("clawhq.memory.get", { name });
        setActiveContent(res.file.content);
        setActiveMeta({ size: res.file.size, updatedMs: res.file.updatedMs });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setActiveContent("");
        setActiveMeta(null);
      }
    },
    [client, status.kind],
  );

  // Initial load — list + long-term in parallel.
  useEffect(() => {
    void loadList();
    void loadLongTerm();
  }, [loadList, loadLongTerm]);

  // Active selection drives the content pane.
  useEffect(() => {
    if (activeKey === LONG_TERM_SENTINEL) {
      setActiveContent(longTerm?.content ?? "");
      setActiveMeta(longTerm ? { size: longTerm.size, updatedMs: longTerm.updatedMs } : null);
      setLoadError(null);
    } else if (activeKey) {
      void loadFile(activeKey);
    }
  }, [activeKey, longTerm, loadFile]);

  const { daily, other } = useMemo(
    () => parseDateEntries(files ?? []),
    [files],
  );

  const filteredDaily = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return daily;
    return daily.filter((e) => e.date.includes(q));
  }, [daily, filter]);

  const monthGroups = useMemo(() => groupByMonth(filteredDaily), [filteredDaily]);

  return (
    <PageShell
      title="Workspace memory"
      subtitle="Daily rollups and long-term notes from the workspace root"
    >
      <div className="cl-memory-wrap">
        <aside className="cl-memory-side">
          <div className="cl-memory-search">
            <input
              type="search"
              placeholder="Filter dates (YYYY or YYYY-MM)…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="cl-memory-search-input"
            />
          </div>
          <div className="cl-memory-side-body">
            <div className="cl-memory-section">
              <div className="cl-memory-section-label">Long-term</div>
              <div
                className={`cl-memory-row${activeKey === LONG_TERM_SENTINEL ? " is-active" : ""}`}
                onClick={() => setActiveKey(LONG_TERM_SENTINEL)}
              >
                <span className="cl-memory-row-icon">🧠</span>
                <span className="cl-memory-row-label">MEMORY.md</span>
                {longTermMissing && <span className="cl-memory-row-meta">empty</span>}
              </div>
              {longTermError && <div className="cl-memory-error">{longTermError}</div>}
            </div>

            {listError && <div className="cl-memory-error">{listError}</div>}

            {monthGroups.length > 0 && (
              <div className="cl-memory-section">
                <div className="cl-memory-section-label">Daily entries</div>
                {monthGroups.map((g) => (
                  <div key={g.month} className="cl-memory-month">
                    <div className="cl-memory-month-label">{formatMonth(g.month)}</div>
                    {g.entries.map((e) => (
                      <div
                        key={e.file.name}
                        className={`cl-memory-row${activeKey === e.file.name ? " is-active" : ""}`}
                        onClick={() => setActiveKey(e.file.name)}
                      >
                        <span className="cl-memory-row-icon">📅</span>
                        <span className="cl-memory-row-label">
                          {formatDate(e.date)}
                          <span className="cl-memory-row-date">{e.date}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {other.length > 0 && (
              <div className="cl-memory-section">
                <div className="cl-memory-section-label">Other files</div>
                {other.map((f) => (
                  <div
                    key={f.name}
                    className={`cl-memory-row${activeKey === f.name ? " is-active" : ""}`}
                    onClick={() => setActiveKey(f.name)}
                  >
                    <span className="cl-memory-row-icon">📄</span>
                    <span className="cl-memory-row-label">{f.name}</span>
                  </div>
                ))}
              </div>
            )}

            {files !== null && monthGroups.length === 0 && other.length === 0 && !filter && (
              <div className="cl-memory-empty">
                No daily entries yet. Run an agent that writes to{" "}
                <code>memory/YYYY-MM-DD.md</code> to fill this in.
              </div>
            )}
            {filter && filteredDaily.length === 0 && (
              <div className="cl-memory-empty">No entries match “{filter}”.</div>
            )}
          </div>
        </aside>
        <main className="cl-memory-main">
          {loadError && <div className="cl-memory-error">{loadError}</div>}
          {activeMeta && (
            <div className="cl-memory-header">
              <div className="cl-memory-title">
                {activeKey === LONG_TERM_SENTINEL ? "Long-term memory" : activeKey}
              </div>
              <div className="cl-memory-meta">
                {formatBytes(activeMeta.size)} · updated{" "}
                {new Date(activeMeta.updatedMs).toLocaleString()}
              </div>
            </div>
          )}
          {activeKey === LONG_TERM_SENTINEL && longTermMissing && (
            <div className="cl-memory-blank">
              No <code>MEMORY.md</code> at the workspace root yet.
            </div>
          )}
          {activeContent && (
            <pre className="cl-memory-body">{activeContent}</pre>
          )}
        </main>
      </div>
    </PageShell>
  );
}
