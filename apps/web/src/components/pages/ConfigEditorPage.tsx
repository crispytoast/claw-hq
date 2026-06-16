import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";
import { PageShell } from "./PageShell.js";
import { requireSudo } from "../SudoGate.js";
import { Settings, Check } from "../icons.js";

interface Props {
  client: GatewayClient | null;
  status: ConnectionStatus;
}

interface ConfigGetResult {
  config?: unknown;
  hash?: string;
}

interface SchemaLookup {
  path?: string;
  schema?: {
    title?: string;
    description?: string;
    type?: string;
    enum?: unknown[];
    deprecated?: boolean;
    readOnly?: boolean;
  };
  hint?: string;
  hintPath?: string;
  reloadKind?: "restart" | "hot" | "none";
  children?: Array<{
    key: string;
    path: string;
    type?: string;
    required?: boolean;
    hasChildren?: boolean;
    reloadKind?: string;
    hint?: string;
  }>;
}

type LeafKind = "string" | "number" | "boolean" | "object" | "array" | "null";

interface LeafEntry {
  path: string;
  value: unknown;
  kind: LeafKind;
}

function classifyLeaf(v: unknown): LeafKind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "string";
}

function flattenConfig(cfg: unknown, prefix = ""): LeafEntry[] {
  if (cfg === null || cfg === undefined) return [];
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    return [{ path: prefix, value: cfg, kind: classifyLeaf(cfg) }];
  }
  const out: LeafEntry[] = [];
  for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenConfig(v, p));
    } else {
      out.push({ path: p, value: v, kind: classifyLeaf(v) });
    }
  }
  return out;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving"; path: string }
  | { kind: "ok"; path: string; reloadKind?: string }
  | { kind: "error"; path: string; message: string };

const RELOAD_LABEL: Record<string, string> = {
  restart: "Gateway restart",
  hot: "hot reload",
  none: "no reload needed",
};

export function ConfigEditorPage({ client, status }: Props) {
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [lookup, setLookup] = useState<SchemaLookup | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const refresh = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    setLoading(true);
    setErr(null);
    try {
      const r = await client.call<ConfigGetResult>("config.get", {});
      setSnapshot(r?.config ?? r ?? null);
      setHash(r?.hash ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, status.kind]);

  useEffect(() => { void refresh(); }, [refresh]);

  const leaves = useMemo(() => flattenConfig(snapshot), [snapshot]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leaves;
    return leaves.filter((l) => l.path.toLowerCase().includes(q));
  }, [leaves, query]);

  const selectedLeaf = useMemo(
    () => leaves.find((l) => l.path === selected) ?? null,
    [leaves, selected],
  );

  // Pull a schema lookup for the selected path so we can show description +
  // reload-kind. Schema.lookup may not exist in older Gateways — fail soft.
  useEffect(() => {
    if (!client || status.kind !== "ready" || !selected) {
      setLookup(null);
      setLookupErr(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await client.call<SchemaLookup>("config.schema.lookup", { path: selected });
        if (!cancelled) {
          setLookup(r);
          setLookupErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setLookup(null);
          setLookupErr(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [client, status.kind, selected]);

  // Seed the draft when the selected leaf changes.
  useEffect(() => {
    if (!selectedLeaf) {
      setDraft("");
      return;
    }
    if (selectedLeaf.kind === "string") {
      setDraft(String(selectedLeaf.value ?? ""));
    } else if (selectedLeaf.kind === "number") {
      setDraft(String(selectedLeaf.value ?? ""));
    } else if (selectedLeaf.kind === "boolean") {
      setDraft(selectedLeaf.value ? "true" : "false");
    } else if (selectedLeaf.kind === "null") {
      setDraft("");
    } else {
      // object / array — JSON edit
      try {
        setDraft(JSON.stringify(selectedLeaf.value, null, 2));
      } catch {
        setDraft("");
      }
    }
    setSave({ kind: "idle" });
  }, [selectedLeaf]);

  const parseDraft = useCallback((): { ok: true; value: unknown } | { ok: false; error: string } => {
    if (!selectedLeaf) return { ok: false, error: "no leaf selected" };
    const k = selectedLeaf.kind;
    if (k === "string") return { ok: true, value: draft };
    if (k === "number") {
      const n = Number(draft);
      if (!Number.isFinite(n)) return { ok: false, error: "not a finite number" };
      return { ok: true, value: n };
    }
    if (k === "boolean") {
      if (draft === "true") return { ok: true, value: true };
      if (draft === "false") return { ok: true, value: false };
      return { ok: false, error: "boolean must be 'true' or 'false'" };
    }
    if (k === "null") {
      return { ok: true, value: draft === "" ? null : draft };
    }
    // object / array
    try {
      return { ok: true, value: JSON.parse(draft) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [draft, selectedLeaf]);

  const commit = useCallback(async () => {
    if (!client || status.kind !== "ready" || !selectedLeaf) return;
    const parsed = parseDraft();
    if (!parsed.ok) {
      setSave({ kind: "error", path: selectedLeaf.path, message: parsed.error });
      return;
    }
    const reloadHint = lookup?.reloadKind === "restart"
      ? "Saving this path triggers a Gateway restart."
      : lookup?.reloadKind === "hot"
        ? "Saving this path triggers a hot reload."
        : "Saving this path applies without reload.";
    const allowed = await requireSudo({
      title: "Edit OpenClaw config",
      body: `Path: ${selectedLeaf.path}\n${reloadHint}`,
      verb: "Save",
      danger: lookup?.reloadKind === "restart",
    });
    if (!allowed) return;
    setSave({ kind: "saving", path: selectedLeaf.path });
    try {
      // OpenClaw's config.patch shape varies across releases; try the
      // single-path shape first, then fall back to the merge-payload shape
      // built from the path segments.
      try {
        await client.call("config.patch", { path: selectedLeaf.path, value: parsed.value });
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        if (!/INVALID_REQUEST|path|param/i.test(msg)) throw firstErr;
        const payload = pathSegmentsToPayload(selectedLeaf.path, parsed.value);
        await client.call("config.patch", payload);
      }
      setSave({
        kind: "ok",
        path: selectedLeaf.path,
        reloadKind: lookup?.reloadKind,
      });
      void refresh();
    } catch (e) {
      setSave({
        kind: "error",
        path: selectedLeaf.path,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [client, status.kind, selectedLeaf, parseDraft, lookup?.reloadKind, refresh]);

  return (
    <PageShell
      title="Config editor"
      subtitle={hash ? `config hash: ${hash.slice(0, 12)}…` : "Edit the OpenClaw config schema-driven"}
      actions={
        <button className="btn-ghost" onClick={() => void refresh()} disabled={loading}>
          {loading ? <span className="spinner" /> : "Refresh"}
        </button>
      }
    >
      {status.kind !== "ready" && (
        <div className="alert error">Tunnel not ready ({status.kind}). Config requires an active Gateway session.</div>
      )}
      {err && <div className="alert error">config.get failed: {err}</div>}

      <div className="config-editor-wrap">
        <aside className="config-editor-list">
          <input
            type="search"
            placeholder="Filter paths…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
          />
          <div className="config-editor-count">
            {filtered.length} of {leaves.length} paths
          </div>
          <div className="config-editor-rows">
            {filtered.length === 0 && (
              <div className="settings-help">No matches.</div>
            )}
            {filtered.map((leaf) => (
              <button
                key={leaf.path}
                type="button"
                className={`config-editor-row ${selected === leaf.path ? "active" : ""}`}
                onClick={() => setSelected(leaf.path)}
              >
                <div className="config-editor-row-path">{leaf.path}</div>
                <div className="config-editor-row-preview">
                  <span className="chip">{leaf.kind}</span>
                  <span className="config-editor-row-value">{previewValue(leaf.value)}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="config-editor-pane">
          {!selectedLeaf ? (
            <div className="empty">
              <div className="big"><Settings size={28} /></div>
              Pick a path on the left to edit.
            </div>
          ) : (
            <>
              <div className="config-editor-pane-head">
                <code className="config-editor-pane-path">{selectedLeaf.path}</code>
                {lookup?.reloadKind && (
                  <span className={`status-pill ${lookup.reloadKind === "none" ? "ok" : lookup.reloadKind === "hot" ? "warn" : "bad"}`}>
                    <span className="status-dot" />
                    {RELOAD_LABEL[lookup.reloadKind] ?? lookup.reloadKind}
                  </span>
                )}
              </div>

              {lookup?.schema?.title && (
                <div className="config-editor-pane-title">{lookup.schema.title}</div>
              )}
              {lookup?.schema?.description && (
                <div className="config-editor-pane-desc">{lookup.schema.description}</div>
              )}
              {lookup?.hint && (
                <div className="settings-help" style={{ marginTop: 4 }}>
                  hint: {lookup.hint}
                </div>
              )}
              {lookupErr && (
                <div className="settings-help" style={{ color: "var(--muted-foreground)", marginTop: 4 }}>
                  (schema.lookup unavailable — editing without metadata)
                </div>
              )}

              <div className="config-editor-pane-body">
                <label className="config-editor-pane-label">Value</label>
                {renderEditor(selectedLeaf, draft, setDraft, lookup)}
              </div>

              <div className="config-editor-pane-actions">
                <button
                  className="btn-primary"
                  disabled={save.kind === "saving" || status.kind !== "ready" || lookup?.schema?.readOnly === true}
                  onClick={() => void commit()}
                >
                  {save.kind === "saving" ? <span className="spinner" /> : "Save"}
                </button>
                {lookup?.schema?.readOnly && (
                  <span className="settings-help" style={{ color: "#d4a017" }}>
                    Read-only path — save will be rejected.
                  </span>
                )}
                {save.kind === "ok" && save.path === selectedLeaf.path && (
                  <span style={{ color: "#6fcf97", fontSize: "0.85rem" }}>
                    Saved <Check size={12} style={{ verticalAlign: "-2px" }} /> {save.reloadKind ? `(${RELOAD_LABEL[save.reloadKind] ?? save.reloadKind})` : null}
                  </span>
                )}
                {save.kind === "error" && save.path === selectedLeaf.path && (
                  <span style={{ color: "var(--red, #d56565)", fontSize: "0.85rem" }}>
                    {save.message}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}

function previewValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") {
    return v.length > 40 ? `"${v.slice(0, 38)}…"` : `"${v}"`;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 40 ? `${s.slice(0, 38)}…` : s;
  } catch {
    return String(v);
  }
}

function pathSegmentsToPayload(path: string, value: unknown): { config: Record<string, unknown> } {
  const parts = path.split(".");
  const out: Record<string, unknown> = {};
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[parts[i]!] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]!] = value;
  return { config: out };
}

function renderEditor(
  leaf: LeafEntry,
  draft: string,
  setDraft: (s: string) => void,
  lookup: SchemaLookup | null,
) {
  const enumVals = Array.isArray(lookup?.schema?.enum) ? (lookup!.schema!.enum as unknown[]) : null;
  if (enumVals && enumVals.every((v) => typeof v === "string" || typeof v === "number")) {
    return (
      <select value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: "100%" }}>
        {enumVals.map((v) => (
          <option key={String(v)} value={String(v)}>{String(v)}</option>
        ))}
      </select>
    );
  }
  if (leaf.kind === "boolean") {
    return (
      <select value={draft} onChange={(e) => setDraft(e.target.value)} style={{ width: 140 }}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (leaf.kind === "object" || leaf.kind === "array") {
    return (
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(20, Math.max(6, draft.split("\n").length))}
        style={{ width: "100%", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.85rem" }}
        placeholder="JSON"
      />
    );
  }
  if (leaf.kind === "number") {
    return (
      <input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        style={{ width: "100%" }}
      />
    );
  }
  // string + null
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      style={{ width: "100%" }}
    />
  );
}
