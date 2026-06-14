import { useCallback, useEffect, useState } from "react";
import { systemApi, type VersionInfo, type UpdateCheck } from "../../system-api.js";

interface UpdaterBridge {
  isAvailable(): boolean;
  downloadAndInstall(): boolean;
}

interface UpdaterCallback {
  type: "started" | "progress" | "installing" | "error";
  text?: string;
  bytes?: number;
  total?: number;
}

function getUpdaterBridge(): UpdaterBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ClawHqUpdater?: UpdaterBridge }).ClawHqUpdater ?? null;
}

export function SettingsUpdatesTab() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [apkProgress, setApkProgress] = useState<{ bytes: number; total: number } | null>(null);
  const [apkPhase, setApkPhase] = useState<"idle" | "downloading" | "installing" | "error">("idle");
  const [apkErr, setApkErr] = useState<string | null>(null);
  const apkUpdater = getUpdaterBridge();

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

  // Register the APK updater callback exactly once. The bridge calls
  // window.__clawHqUpdaterCallback(JSON) for every lifecycle event so we
  // can show progress + handoff state inline in the Settings pane.
  useEffect(() => {
    if (!apkUpdater) return;
    const handler = (raw: string) => {
      let payload: UpdaterCallback;
      try { payload = JSON.parse(raw) as UpdaterCallback; } catch { return; }
      if (payload.type === "started") {
        setApkPhase("downloading");
        setApkProgress(null);
        setApkErr(null);
        return;
      }
      if (payload.type === "progress") {
        setApkProgress({
          bytes: payload.bytes ?? 0,
          total: payload.total ?? 0,
        });
        return;
      }
      if (payload.type === "installing") {
        setApkPhase("installing");
        return;
      }
      if (payload.type === "error") {
        setApkPhase("error");
        setApkErr(payload.text ?? "unknown error");
      }
    };
    (window as unknown as Record<string, unknown>)["__clawHqUpdaterCallback"] = handler;
    return () => {
      if ((window as unknown as Record<string, unknown>)["__clawHqUpdaterCallback"] === handler) {
        delete (window as unknown as Record<string, unknown>)["__clawHqUpdaterCallback"];
      }
    };
  }, [apkUpdater]);

  const installApk = useCallback(() => {
    if (!apkUpdater) return;
    try { apkUpdater.downloadAndInstall(); } catch (e) {
      setApkPhase("error");
      setApkErr(e instanceof Error ? e.message : String(e));
    }
  }, [apkUpdater]);

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

      {apkUpdater && (
        <div className="settings-card" style={{ marginTop: "1rem" }}>
          <div className="settings-card-title">Update this APK</div>
          <p className="settings-help">
            Pulls the latest APK from <code>/install/apk</code> and hands it to Android's
            installer. The system will prompt you to confirm — same flow as sideloading manually.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              className="btn-primary"
              onClick={installApk}
              disabled={apkPhase === "downloading" || apkPhase === "installing"}
            >
              {apkPhase === "downloading" || apkPhase === "installing"
                ? <span className="spinner" />
                : "Download + install latest"}
            </button>
            {apkPhase === "downloading" && apkProgress && apkProgress.total > 0 && (
              <span className="settings-help" style={{ margin: 0 }}>
                {(apkProgress.bytes / 1024 / 1024).toFixed(2)} / {(apkProgress.total / 1024 / 1024).toFixed(2)} MB
                {" "}({Math.round((apkProgress.bytes / apkProgress.total) * 100)}%)
              </span>
            )}
            {apkPhase === "installing" && (
              <span className="settings-help" style={{ margin: 0 }}>
                Handing off to system installer…
              </span>
            )}
          </div>
          {apkErr && <div className="settings-err" style={{ marginTop: "0.5rem" }}>{apkErr}</div>}
        </div>
      )}

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
