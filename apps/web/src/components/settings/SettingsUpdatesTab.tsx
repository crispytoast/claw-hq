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

interface BuildBridge {
  getVersionName(): string;
  getVersionCode(): number;
  getApplicationId(): string;
  getInstallerPackage(): string | null;
}

function getUpdaterBridge(): UpdaterBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ClawHqUpdater?: UpdaterBridge }).ClawHqUpdater ?? null;
}

function getBuildBridge(): BuildBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ClawHqBuild?: BuildBridge }).ClawHqBuild ?? null;
}

function readApkInfo(): { versionName: string; versionCode: number } | null {
  const b = getBuildBridge();
  if (!b) return null;
  try {
    return { versionName: b.getVersionName(), versionCode: b.getVersionCode() };
  } catch {
    return null;
  }
}

function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function SettingsUpdatesTab() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [apkProgress, setApkProgress] = useState<{ bytes: number; total: number } | null>(null);
  const [apkPhase, setApkPhase] = useState<"idle" | "downloading" | "installing" | "error">("idle");
  const [apkErr, setApkErr] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const apkUpdater = getUpdaterBridge();
  const apk = readApkInfo();
  const webBuildTime = __APP_BUILD_TIME__;
  const webGitSha = __APP_GIT_SHA__;

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
      setLastCheckedAt(Date.now());
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
        <div className="settings-card-title">What's running</div>
        <dl className="settings-kv">
          {apk && (
            <>
              <dt>App (APK)</dt>
              <dd><code>v{apk.versionName}</code> <span className="settings-help" style={{ margin: 0 }}>(build {apk.versionCode})</span></dd>
            </>
          )}
          <dt>Web bundle</dt>
          <dd>
            <code>{webGitSha}</code>{" "}
            <span className="settings-help" style={{ margin: 0 }}>built {formatBuildTime(webBuildTime)}</span>
          </dd>
          <dt>Relay (server)</dt>
          <dd><code>v{info?.current ?? "…"}</code> <span className="settings-help" style={{ margin: 0 }}>({info?.installMethod ?? "…"})</span></dd>
        </dl>
        {!apk && (
          <p className="settings-help" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
            Open this page inside the Claw HQ APK to see the installed app version too.
          </p>
        )}
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
              <p>Relay is on v{check.current}. To update:</p>
              <UpdateInstructions installMethod={info?.installMethod ?? "unknown"} latest={check.latest} releaseUrl={check.releaseUrl} />
            </>
          ) : (
            <>
              <div className="settings-card-title">
                <span className="dot dot-green" /> Relay is up to date (v{check.current})
              </div>
              {check.releaseUrl && (
                <p className="settings-help" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
                  Latest release: <a href={check.releaseUrl} target="_blank" rel="noopener noreferrer">{check.releaseUrl}</a>
                </p>
              )}
            </>
          )}
          {lastCheckedAt && (
            <p className="settings-help" style={{ marginTop: "0.5rem", marginBottom: 0 }}>
              Checked {new Date(lastCheckedAt).toLocaleTimeString()}.
            </p>
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
