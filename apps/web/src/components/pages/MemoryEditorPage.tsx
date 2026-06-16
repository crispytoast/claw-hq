import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import type { OpenClawEvent } from "@claw-hq/protocol-types";
import { PageShell } from "./PageShell.js";
import { Brain, Plus } from "../icons.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
  /** Project slug to edit, or `null` for workspace-level (<workspace>/memory/). */
  projectSlug: string | null;
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

interface PutResponse {
  projectSlug: string | null;
  file: MemoryFileContent & { created: boolean };
}

const NEW_FILE_SENTINEL = "__new__";
const VALID_FILENAME_HINT = "Letters, digits, dot, dash, underscore. Must end in .md.";

export function MemoryEditorPage({ client, status, projectSlug }: Props) {
  const [files, setFiles] = useState<MemoryFileSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [activeContent, setActiveContent] = useState<string>("");
  const [activeMeta, setActiveMeta] = useState<MemoryFileSummary | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNameError, setNewNameError] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setListError(null);
    try {
      const res = await client.call<ListResponse>("clawhq.memory.list", {
        projectSlug: projectSlug ?? undefined,
      });
      setFiles(res.files);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setFiles([]);
    }
  }, [client, status.kind, projectSlug]);

  const loadFile = useCallback(
    async (name: string) => {
      if (!client || status.kind !== "ready") return;
      setSaveError(null);
      try {
        const res = await client.call<GetResponse>("clawhq.memory.get", {
          projectSlug: projectSlug ?? undefined,
          name,
        });
        setActiveName(name);
        setActiveContent(res.file.content);
        setActiveMeta(res.file);
        setDirty(false);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    },
    [client, status.kind, projectSlug],
  );

  useEffect(() => {
    setActiveName(null);
    setActiveContent("");
    setActiveMeta(null);
    setDirty(false);
    setCreating(false);
    setFiles(null);
    void loadFiles();
  }, [loadFiles]);

  // Live updates: cross-device put / delete refresh our state.
  useEffect(() => {
    if (!client) return;
    return client.onEvent((ev: OpenClawEvent) => {
      if (ev.event !== "plugin.clawhq.memory.updated" && ev.event !== "plugin.clawhq.memory.deleted") {
        return;
      }
      const p = (ev.payload ?? {}) as { projectSlug?: unknown; name?: unknown };
      const evSlug = typeof p.projectSlug === "string" && p.projectSlug ? p.projectSlug : null;
      if (evSlug !== projectSlug) return;
      void loadFiles();
      if (
        ev.event === "plugin.clawhq.memory.deleted" &&
        typeof p.name === "string" &&
        p.name === activeName
      ) {
        setActiveName(null);
        setActiveContent("");
        setActiveMeta(null);
        setDirty(false);
      }
    });
  }, [client, projectSlug, activeName, loadFiles]);

  const save = useCallback(async () => {
    if (!client || status.kind !== "ready" || !activeName) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await client.call<PutResponse>("clawhq.memory.put", {
        projectSlug: projectSlug ?? undefined,
        name: activeName,
        content: activeContent,
      });
      setActiveMeta(res.file);
      setDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [client, status.kind, projectSlug, activeName, activeContent]);

  const remove = useCallback(async () => {
    if (!client || status.kind !== "ready" || !activeName) return;
    const confirmed = window.confirm(`Delete "${activeName}"? This can't be undone.`);
    if (!confirmed) return;
    try {
      await client.call("clawhq.memory.delete", { projectSlug: projectSlug ?? undefined, name: activeName });
      setActiveName(null);
      setActiveContent("");
      setActiveMeta(null);
      setDirty(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [client, status.kind, projectSlug, activeName]);

  const createNew = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    const name = newName.trim();
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/.test(name)) {
      setNewNameError(VALID_FILENAME_HINT);
      return;
    }
    setNewNameError(null);
    try {
      const res = await client.call<PutResponse>("clawhq.memory.put", {
        projectSlug: projectSlug ?? undefined,
        name,
        content: "",
      });
      setActiveName(res.file.name);
      setActiveContent(res.file.content);
      setActiveMeta(res.file);
      setDirty(false);
      setCreating(false);
      setNewName("");
    } catch (err) {
      setNewNameError(err instanceof Error ? err.message : String(err));
    }
  }, [client, status.kind, projectSlug, newName]);

  const onPickFile = useCallback(
    (name: string) => {
      if (dirty) {
        const ok = window.confirm("Discard unsaved changes?");
        if (!ok) return;
      }
      void loadFile(name);
    },
    [dirty, loadFile],
  );

  const wordCount = useMemo(() => {
    return activeContent.trim().length === 0
      ? 0
      : activeContent.trim().split(/\s+/).length;
  }, [activeContent]);

  return (
    <PageShell
      title={projectSlug ? `${projectSlug} · Memory` : "Workspace · Memory"}
      subtitle={
        projectSlug
          ? "Edit per-project memory files (workspace/projects/<slug>/memory/*.md)"
          : "Edit shared workspace memory files (workspace/memory/*.md)"
      }
      actions={
        <button className="btn-ghost" onClick={() => void loadFiles()} disabled={status.kind !== "ready"}>
          Refresh
        </button>
      }
    >
      <div className="memory-editor">
        <div className="memory-sidebar">
          <button
            type="button"
            className="cl-new-btn"
            onClick={() => {
              setCreating(true);
              setNewName("");
              setNewNameError(null);
              setActiveName(NEW_FILE_SENTINEL);
            }}
          >
            <Plus size={12} />
            <span>New memory file</span>
          </button>
          {creating && (
            <div className="memory-new-row">
              <input
                autoFocus
                className="cl-rename-input"
                placeholder="e.g. notes.md"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createNew();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCreating(false);
                    setActiveName(null);
                  }
                }}
              />
              <button className="btn-ghost" onClick={() => void createNew()}>Create</button>
              {newNameError && <div className="memory-error">{newNameError}</div>}
            </div>
          )}
          {listError && <div className="memory-error">{listError}</div>}
          {files === null ? (
            <div className="empty"><div className="spinner" />Loading…</div>
          ) : files.length === 0 ? (
            <div className="cl-list-empty">No memory files yet.</div>
          ) : (
            <div className="cl-list">
              {files.map((f) => {
                const isActive = f.name === activeName;
                return (
                  <button
                    key={f.name}
                    type="button"
                    className={`cl-row ${isActive ? "cl-active" : ""}`}
                    onClick={() => onPickFile(f.name)}
                  >
                    <div className="cl-row-main">
                      <span className="cl-row-title">{f.name}</span>
                    </div>
                    <div className="cl-row-meta">
                      <span>{formatBytes(f.size)}</span>
                      <span>·</span>
                      <span>{relativeTime(f.updatedMs)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="memory-pane">
          {!activeName || activeName === NEW_FILE_SENTINEL ? (
            <div className="empty">
              <div className="big"><Brain size={28} /></div>
              {creating ? "Pick a filename and press Create." : "Pick a memory file to view or edit."}
            </div>
          ) : (
            <>
              <div className="memory-pane-header">
                <div className="memory-pane-title">{activeName}</div>
                <div className="memory-pane-meta">
                  {activeMeta && (
                    <>
                      <span>{formatBytes(activeMeta.size)}</span>
                      <span>·</span>
                      <span>updated {relativeTime(activeMeta.updatedMs)}</span>
                      <span>·</span>
                      <span>{wordCount} words</span>
                    </>
                  )}
                </div>
                <div className="memory-pane-actions">
                  <button
                    className="btn-ghost"
                    onClick={() => void save()}
                    disabled={!dirty || saving}
                  >
                    {saving ? "Saving…" : dirty ? "Save" : "Saved"}
                  </button>
                  <button className="btn-ghost" onClick={() => void remove()}>
                    Delete
                  </button>
                </div>
              </div>
              {saveError && <div className="alert error">{saveError}</div>}
              <textarea
                className="memory-textarea"
                value={activeContent}
                spellCheck={false}
                onChange={(e) => {
                  setActiveContent(e.target.value);
                  setDirty(true);
                }}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+S saves without leaving the page.
                  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function relativeTime(ms: number): string {
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
