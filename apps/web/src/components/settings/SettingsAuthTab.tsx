import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";
import { requireSudo } from "../SudoGate.js";

const MIN_LEN = 12;

export function SettingsAuthTab() {
  const [mode, setMode] = useState<string | null>(null);
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      const m = await api.getAuthMode();
      setMode(m.mode);
      setHasPassphrase(m.hasPassphrase);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setDone(null);
    if (pass1.length < MIN_LEN) {
      setErr(`Passphrase must be at least ${MIN_LEN} characters.`);
      return;
    }
    if (pass1 !== pass2) {
      setErr("Passphrases don't match.");
      return;
    }
    const verb = hasPassphrase ? "Rotate passphrase" : "Switch to shared-secret";
    const body = hasPassphrase
      ? "Every signed-in device will keep its session. Future logins use the new passphrase."
      : "Every device — including this one — will be logged out and prompted for the passphrase. There is no recovery if you forget it (only editing config.json on the relay machine). Make sure it's saved somewhere safe.";
    const okay = await requireSudo({
      title: verb,
      body,
      verb,
      danger: !hasPassphrase,
    });
    if (!okay) return;
    setWorking(true);
    const wasFirstFlip = !hasPassphrase;
    try {
      await api.setSharedSecret(pass1);
      setPass1("");
      setPass2("");
      setDone(wasFirstFlip
        ? "Auth mode flipped. Reloading to the login screen…"
        : "Passphrase rotated.");
      await refresh();
      if (wasFirstFlip) {
        // First flip: the page is now in a no-cookie state but App.tsx still
        // thinks we're authed (it loaded under trusted-lan). Reload so the
        // root re-fetches /api/auth/me, sees 401 + mode=shared-secret, and
        // shows the passphrase login screen.
        window.setTimeout(() => { window.location.reload(); }, 800);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  if (busy) return <div className="settings-section"><div className="spinner" /></div>;

  return (
    <div className="settings-section">
      <h2>Authentication</h2>
      <p className="muted">
        Current mode: <strong>{mode ?? "unknown"}</strong>
        {mode === "shared-secret" && hasPassphrase && " — passphrase set"}
      </p>

      {mode === "real-auth" ? (
        <div className="muted">
          You're in <strong>real-auth</strong> mode (email + password accounts).
          Switching modes from the UI is only supported between trusted-lan and
          shared-secret. Edit <code>~/.claw-hq/config.json</code> on the relay
          machine if you need to change to or from real-auth.
        </div>
      ) : (
        <>
          <p className="muted">
            {mode === "trusted-lan"
              ? "Anyone who can reach this relay is currently signed in as the owner. Set a passphrase to require login."
              : "Rotate the shared passphrase. Existing sessions stay signed in until they expire."}
          </p>

          <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 360 }}>
            <div className="field">
              <label>New passphrase</label>
              <input
                type="password"
                value={pass1}
                onChange={(e) => setPass1(e.target.value)}
                placeholder={`at least ${MIN_LEN} characters`}
                autoComplete="new-password"
              />
            </div>
            <div className="field">
              <label>Confirm passphrase</label>
              <input
                type="password"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="err">{err || " "}</div>
            {done && <div className="muted" style={{ color: "var(--accent)" }}>{done}</div>}
            <button type="submit" className="btn-primary" disabled={working || !pass1 || !pass2}>
              {working
                ? <span className="spinner" />
                : hasPassphrase ? "Rotate passphrase" : "Switch to shared-secret"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
