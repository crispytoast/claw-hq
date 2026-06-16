import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { Chevron, Document } from "../icons.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface DocSummary {
  relativePath: string;
  name: string;
  dir: string;
  size: number;
  updatedMs: number;
}

interface DocContent extends DocSummary {
  content: string;
}

interface DocSnippet {
  line: number;
  snippet: string;
}

interface DocSearchHit {
  doc: DocSummary;
  matchCount: number;
  snippets: DocSnippet[];
  titleMatched: boolean;
}

interface ListResponse {
  docs: DocSummary[];
  workspaceRoot: string | null;
}

interface GetResponse {
  doc: DocContent;
}

interface SearchResponse {
  hits: DocSearchHit[];
  totalDocsScanned: number;
  query: string;
}

/**
 * Tree row: a directory (with `children`) or a file (with `relativePath`).
 * Built from the flat list returned by `clawhq.docs.list`.
 */
interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  doc: DocSummary | null;
}

function buildTree(docs: DocSummary[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [], doc: null };
  for (const doc of docs) {
    const segments = doc.relativePath.split("/");
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      let child = cursor.children.find((c) => c.isDir && c.name === seg);
      if (!child) {
        const segPath = segments.slice(0, i + 1).join("/");
        child = { name: seg, path: segPath, isDir: true, children: [], doc: null };
        cursor.children.push(child);
      }
      cursor = child;
    }
    cursor.children.push({
      name: segments[segments.length - 1]!,
      path: doc.relativePath,
      isDir: false,
      children: [],
      doc,
    });
  }
  // Stable: dirs before files, alphabetical within each group.
  const sortNode = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) if (c.isDir) sortNode(c);
  };
  sortNode(root);
  return root;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  expanded: Set<string>;
  onToggle(path: string): void;
  onPick(relativePath: string): void;
}

function TreeRow({ node, depth, activePath, expanded, onToggle, onPick }: TreeRowProps) {
  if (node.isDir) {
    const isOpen = expanded.has(node.path);
    return (
      <>
        <div
          className="cl-docs-tree-row cl-docs-tree-dir"
          style={{ paddingLeft: depth * 14 + 12 }}
          onClick={() => onToggle(node.path)}
        >
          <span className="cl-docs-tree-twisty"><Chevron dir={isOpen ? "down" : "right"} size={11} /></span>
          <span className="cl-docs-tree-name">{node.name || "/"}</span>
        </div>
        {isOpen &&
          node.children.map((c) => (
            <TreeRow
              key={c.path || c.name}
              node={c}
              depth={depth + 1}
              activePath={activePath}
              expanded={expanded}
              onToggle={onToggle}
              onPick={onPick}
            />
          ))}
      </>
    );
  }
  const active = activePath === node.path;
  return (
    <div
      className={`cl-docs-tree-row cl-docs-tree-file${active ? " is-active" : ""}`}
      style={{ paddingLeft: depth * 14 + 12 }}
      onClick={() => onPick(node.path)}
    >
      <span className="cl-docs-tree-twisty" aria-hidden><Document size={11} /></span>
      <span className="cl-docs-tree-name">{node.name}</span>
    </div>
  );
}

export function DocsPage({ client, status }: Props) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeDoc, setActiveDoc] = useState<DocContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<DocSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const loadList = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setListError(null);
    try {
      const res = await client.call<ListResponse>("clawhq.docs.list", {});
      setDocs(res.docs);
      setWorkspaceRoot(res.workspaceRoot);
      // Auto-expand the top-level dirs so the tree isn't a flat list of folders.
      setExpanded((prev) => {
        if (prev.size > 0) return prev;
        const next = new Set<string>();
        for (const doc of res.docs) {
          const first = doc.relativePath.split("/")[0];
          if (first && first !== doc.relativePath) next.add(first);
        }
        return next;
      });
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setDocs([]);
    }
  }, [client, status.kind]);

  const loadDoc = useCallback(
    async (relativePath: string) => {
      if (!client || status.kind !== "ready") return;
      setLoadError(null);
      setActivePath(relativePath);
      try {
        const res = await client.call<GetResponse>("clawhq.docs.get", {
          relativePath,
        });
        setActiveDoc(res.doc);
        // When opened from a search hit, expand the ancestor dirs so the tree
        // shows the file in context.
        setExpanded((prev) => {
          const next = new Set(prev);
          const segs = relativePath.split("/");
          for (let i = 1; i < segs.length; i++) {
            next.add(segs.slice(0, i).join("/"));
          }
          return next;
        });
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setActiveDoc(null);
      }
    },
    [client, status.kind],
  );

  const runSearch = useCallback(
    async (q: string) => {
      if (!client || status.kind !== "ready") return;
      const trimmed = q.trim();
      if (!trimmed) {
        setSearchHits(null);
        setSearchError(null);
        return;
      }
      setSearching(true);
      setSearchError(null);
      try {
        const res = await client.call<SearchResponse>("clawhq.docs.search", {
          query: trimmed,
        });
        setSearchHits(res.hits);
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : String(err));
        setSearchHits([]);
      } finally {
        setSearching(false);
      }
    },
    [client, status.kind],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Debounce search so we don't burn the gateway on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      void runSearch(query);
    }, 200);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const tree = useMemo(() => (docs ? buildTree(docs) : null), [docs]);

  const toggleDir = useCallback((p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  return (
    <PageShell
      title="Docs"
      subtitle={
        workspaceRoot
          ? `${docs?.length ?? "—"} markdown files under ${workspaceRoot}`
          : "Workspace markdown browser"
      }
    >
      <div className="cl-docs-wrap">
        <aside className="cl-docs-side">
          <div className="cl-docs-search">
            <input
              type="search"
              placeholder="Search workspace docs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="cl-docs-search-input"
            />
            {searching && <div className="cl-docs-search-status">Searching…</div>}
            {searchError && <div className="cl-docs-search-error">{searchError}</div>}
          </div>
          <div className="cl-docs-side-body">
            {listError && <div className="cl-docs-error">{listError}</div>}
            {searchHits ? (
              <div className="cl-docs-hits">
                {searchHits.length === 0 ? (
                  <div className="cl-docs-empty">No matches.</div>
                ) : (
                  searchHits.map((hit) => (
                    <div
                      key={hit.doc.relativePath}
                      className={`cl-docs-hit${activePath === hit.doc.relativePath ? " is-active" : ""}`}
                      onClick={() => void loadDoc(hit.doc.relativePath)}
                    >
                      <div className="cl-docs-hit-path">{hit.doc.relativePath}</div>
                      <div className="cl-docs-hit-meta">
                        {hit.matchCount} match{hit.matchCount === 1 ? "" : "es"}
                        {hit.titleMatched ? " · title" : ""}
                      </div>
                      {hit.snippets.map((s, i) => (
                        <div key={i} className="cl-docs-hit-snippet">
                          <span className="cl-docs-hit-line">L{s.line + 1}</span>{" "}
                          {s.snippet}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="cl-docs-tree">
                {tree?.children.map((c) => (
                  <TreeRow
                    key={c.path || c.name}
                    node={c}
                    depth={0}
                    activePath={activePath}
                    expanded={expanded}
                    onToggle={toggleDir}
                    onPick={(p) => void loadDoc(p)}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>
        <main className="cl-docs-main">
          {!activeDoc && !loadError && (
            <div className="cl-docs-blank">
              Pick a doc on the left, or search across the whole workspace.
            </div>
          )}
          {loadError && <div className="cl-docs-error">{loadError}</div>}
          {activeDoc && (
            <>
              <div className="cl-docs-header">
                <div className="cl-docs-title">{activeDoc.name}</div>
                <div className="cl-docs-meta">
                  {activeDoc.relativePath} · {formatBytes(activeDoc.size)} · updated{" "}
                  {formatRelative(activeDoc.updatedMs)}
                </div>
              </div>
              <pre className="cl-docs-body">{activeDoc.content}</pre>
            </>
          )}
        </main>
      </div>
    </PageShell>
  );
}
