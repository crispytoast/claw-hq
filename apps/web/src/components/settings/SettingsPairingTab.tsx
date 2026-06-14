import { useCallback, useEffect, useState } from "react";
import { api, type PairingToken } from "../../api.js";

interface IssuedToken {
  pairingToken: string;
  label: string;
  createdAt: number;
  pairCommand: string;
  relayUrl: string;
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

export function SettingsPairingTab() {
  const [tokens, setTokens] = useState<PairingToken[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      setTokens(await api.listPairingTokens());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const issue = useCallback(async () => {
    const label = newLabel.trim() || "unnamed device";
    setIssuing(true);
    setErr("");
    try {
      const result = await api.issuePairingToken(label);
      setIssued(result);
      setNewLabel("");
      void refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setIssuing(false);
    }
  }, [newLabel, refresh]);

  const revoke = useCallback(
    async (token: string, label: string) => {
      if (!window.confirm(`Revoke pairing for "${label}"? Any device using this token will lose access.`)) return;
      setRevoking((s) => new Set(s).add(token));
      try {
        await api.revokePairingToken(token);
        void refresh();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setRevoking((s) => {
          const next = new Set(s);
          next.delete(token);
          return next;
        });
      }
    },
    [refresh],
  );

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may be blocked outside HTTPS — fall back to alert prompt.
      window.prompt("Copy this:", text);
    }
  }, []);

  return (
    <div className="settings-pane">
      <h2>Paired devices</h2>
      <p className="settings-help">
        Each Claw HQ install (phone APK, browser session, CLI) gets its own pairing token.
        Revoke one to kick that device.
      </p>

      {issued && (
        <div className="settings-card pairing-issued">
          <div className="settings-card-title">New pairing token issued for "{issued.label}"</div>
          <p className="settings-help" style={{ marginBottom: 8 }}>
            Run this on the device to pair it (token shown once — copy it now):
          </p>
          <pre className="pairing-cmd-block">{issued.pairCommand}</pre>
          <div className="pairing-actions">
            <button
              className="btn-primary"
              onClick={() => void copyToClipboard(issued.pairCommand)}
            >{copied ? "Copied ✓" : "Copy command"}</button>
            <button className="btn-ghost" onClick={() => setIssued(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <div className="settings-card">
        <div className="settings-card-title">Issue new pairing token</div>
        <div className="pairing-issue-row">
          <input
            type="text"
            placeholder="Device label (e.g. franks-s24-ultra)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            disabled={issuing}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void issue();
              }
            }}
          />
          <button className="btn-primary" onClick={() => void issue()} disabled={issuing}>
            {issuing ? <span className="spinner" /> : "Issue"}
          </button>
        </div>
      </div>

      {err && <div className="settings-err">{err}</div>}

      <h3 style={{ marginTop: "1.5rem" }}>Active pairings</h3>
      {busy && tokens === null && <div className="spinner" />}
      {!busy && tokens && tokens.length === 0 && (
        <p className="settings-help">No devices paired yet. Issue a token above to bring the first one online.</p>
      )}
      {tokens && tokens.length > 0 && (
        <ul className="pairing-list">
          {tokens.map((t) => {
            const isRevoking = revoking.has(t.token);
            const tokenShort = `${t.token.slice(0, 8)}…${t.token.slice(-4)}`;
            return (
              <li key={t.token} className="pairing-row">
                <div className="pairing-row-main">
                  <div className="pairing-row-title">{t.label}</div>
                  <div className="pairing-row-sub">
                    <code title={t.token}>{tokenShort}</code>
                    {" · created "}{relativeTime(t.createdAt)}
                    {" · "}
                    {t.lastUsedAt
                      ? `last used ${relativeTime(t.lastUsedAt)}`
                      : "never used"}
                  </div>
                </div>
                <button
                  className="btn-ghost danger"
                  disabled={isRevoking}
                  onClick={() => void revoke(t.token, t.label)}
                >
                  {isRevoking ? <span className="spinner" /> : "Revoke"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
