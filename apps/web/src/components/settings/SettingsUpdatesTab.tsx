import { useEffect, useState } from "react";
import { systemApi, type VersionInfo, type UpdateCheck } from "../../system-api.js";

export function SettingsUpdatesTab() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    void (async () => {
      try { setInfo(await systemApi.version()); } catch { /* noop */ }
    })();
  }, []);

  const runCheck = async () => {
    setBusy(true);
    setErr("");
    try {
      setCheck(await systemApi.checkUpdates());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-pane">
      <h2>Updates</h2>
      <p className="settings-help">
        Claw HQ checks for new releases on demand — no telemetry, no background polling.
        Updates apply differently depending on how you installed.
      </p>

      <div className="settings-card">
        <dl className="settings-kv">
          <dt>Current version</dt><dd><code>{info?.current ?? "…"}</code></dd>
          <dt>Install method</dt><dd>{info?.installMethod ?? "…"}</dd>
        </dl>
      </div>

      <div style={{ marginTop: "1rem" }}>
        <button className="btn-primary" onClick={runCheck} disabled={busy}>
          {busy ? <span className="spinner" /> : "Check for updates"}
        </button>
      </div>

      {err && <div className="settings-err" style={{ marginTop: "0.75rem" }}>{err}</div>}

      {check && (
        <div className="settings-card" style={{ marginTop: "1rem" }}>
          {check.note ? (
            <p>{check.note}</p>
          ) : check.updateAvailable ? (
            <>
              <div className="settings-card-title">
                <span className="dot dot-amber" /> Update available — v{check.latest}
              </div>
              <p>You're on v{check.current}. To update:</p>
              <UpdateInstructions installMethod={info?.installMethod ?? "unknown"} latest={check.latest} releaseUrl={check.releaseUrl} />
            </>
          ) : (
            <div className="settings-card-title">
              <span className="dot dot-green" /> You're up to date (v{check.current})
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UpdateInstructions({
  installMethod, latest, releaseUrl,
}: {
  installMethod: string;
  latest: string;
  releaseUrl?: string | null;
}) {
  if (installMethod === "npm") {
    return (
      <>
        <pre className="code-block">{`npm install -g @claw-hq/cli@${latest}
systemctl --user restart claw-hq`}</pre>
      </>
    );
  }
  if (installMethod === "docker") {
    return (
      <>
        <pre className="code-block">{`docker pull claw-hq/claw-hq:${latest}
docker stop claw-hq && docker rm claw-hq
docker run -d --name claw-hq -p 3838:3838 -v ~/.claw-hq:/data -v ~/.openclaw:/openclaw:ro claw-hq/claw-hq:${latest}`}</pre>
      </>
    );
  }
  return (
    <>
      <p>See the release notes for upgrade instructions specific to your install.</p>
      {releaseUrl && (
        <p>
          <a href={releaseUrl} target="_blank" rel="noopener noreferrer">Open release notes →</a>
        </p>
      )}
    </>
  );
}
