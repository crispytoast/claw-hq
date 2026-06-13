import { useEffect, useState } from "react";
import { systemApi, type PushConfigStatus } from "../../system-api.js";

/**
 * Push notification setup. Each Claw HQ user runs their own Firebase project —
 * this tab is the wizard that walks them through it.
 */
export function SettingsNotificationsTab() {
  const [status, setStatus] = useState<PushConfigStatus | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  const refresh = async () => {
    try { setStatus(await systemApi.pushConfig()); } catch { /* noop */ }
  };
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="settings-pane">
      <h2>Push notifications</h2>
      <p className="settings-help">
        Get pinged on your phone when an agent finishes a long run, when a tool wants approval,
        or based on rules you set. Works through your own Firebase project — Claw HQ never sees
        your data and we never run a central push server.
      </p>

      {status && !status.configured && !showWizard && (
        <div className="settings-card">
          <div className="settings-card-title"><span className="dot dot-red" /> Not configured</div>
          <p>Push notifications need a Firebase Cloud Messaging project you own.</p>
          <button className="btn-primary" onClick={() => setShowWizard(true)}>
            Set up push notifications
          </button>
        </div>
      )}

      {status && status.configured && !showWizard && (
        <div className="settings-card">
          <div className="settings-card-title"><span className="dot dot-green" /> Configured</div>
          <dl className="settings-kv">
            <dt>Firebase project</dt><dd><code>{status.projectId}</code></dd>
            <dt>Updated</dt><dd>{status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "—"}</dd>
          </dl>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button className="btn-ghost" onClick={() => setShowWizard(true)}>Re-configure</button>
            <button className="btn-ghost" onClick={async () => {
              if (!confirm("Disable push notifications? You can set up again later.")) return;
              await systemApi.clearPushConfig();
              await refresh();
            }}>Disable</button>
          </div>
        </div>
      )}

      {showWizard && (
        <PushWizard
          onDone={async () => { setShowWizard(false); await refresh(); }}
          onCancel={() => setShowWizard(false)}
        />
      )}

      <h2 style={{ marginTop: "1.5rem" }}>Notification triggers</h2>
      <p className="settings-help">
        Once push is set up, the following will ping your device. Per-trigger rules are coming in v0.3.1.
      </p>
      <ul className="settings-list">
        <li>Agent run finished — when a chat completes a long-running turn</li>
        <li>Tool approval needed — when a tool wants permission to run</li>
        <li>(More triggers come with the rules UI)</li>
      </ul>
    </div>
  );
}

function PushWizard({ onDone, onCancel }: { onDone(): void | Promise<void>; onCancel(): void }) {
  const [step, setStep] = useState(1);
  const [projectId, setProjectId] = useState("");
  const [googleServicesText, setGoogleServicesText] = useState("");
  const [serviceAccountText, setServiceAccountText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr("");
    setBusy(true);
    try {
      let googleServicesJson: unknown = undefined;
      let serviceAccountJson: unknown = undefined;
      if (googleServicesText.trim()) {
        googleServicesJson = JSON.parse(googleServicesText);
      }
      if (serviceAccountText.trim()) {
        serviceAccountJson = JSON.parse(serviceAccountText);
      }
      if (!projectId) throw new Error("Firebase project ID required");
      if (!googleServicesJson) throw new Error("google-services.json required");
      if (!serviceAccountJson) throw new Error("Service-account JSON required");
      await systemApi.setPushConfig({ projectId, googleServicesJson, serviceAccountJson });
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="settings-card-title">Set up Firebase Cloud Messaging</div>

      {step === 1 && (
        <>
          <p>
            <strong>Step 1.</strong> Create a Firebase project (free) at{" "}
            <a href="https://console.firebase.google.com/" target="_blank" rel="noopener noreferrer">
              console.firebase.google.com
            </a>. Name it whatever you like — "claw-hq" works.
          </p>
          <p>
            In the project, add an Android app with the package name{" "}
            <code>ai.clawhq.app</code>. Download the resulting{" "}
            <code>google-services.json</code>.
          </p>
          <p>
            Then go to Project Settings → Service accounts → "Generate new private key". Download the JSON.
          </p>
          <p>You'll paste both files in the next step.</p>
          <div className="row">
            <button className="btn-ghost" onClick={onCancel}>Cancel</button>
            <button className="btn-primary" onClick={() => setStep(2)}>Next</button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p><strong>Step 2.</strong> Paste your Firebase details below.</p>
          <div className="field">
            <label>Firebase project ID</label>
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value.trim())}
              placeholder="my-claw-hq"
            />
          </div>
          <div className="field">
            <label>google-services.json (Android client config)</label>
            <textarea
              value={googleServicesText}
              onChange={(e) => setGoogleServicesText(e.target.value)}
              placeholder="paste the entire JSON file here"
              rows={5}
              style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: "0.78rem" }}
            />
          </div>
          <div className="field">
            <label>Service-account JSON (backend FCM sender)</label>
            <textarea
              value={serviceAccountText}
              onChange={(e) => setServiceAccountText(e.target.value)}
              placeholder="paste the entire service-account JSON here"
              rows={5}
              style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: "0.78rem" }}
            />
          </div>
          {err && <div className="settings-err">{err}</div>}
          <div className="row">
            <button className="btn-ghost" onClick={() => setStep(1)}>Back</button>
            <button className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? <span className="spinner" /> : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
