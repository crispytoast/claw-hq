import { useEffect, useState } from "react";
import { api, type User } from "./api.js";
import { systemApi } from "./system-api.js";
import { Login, type LoginMode } from "./components/Login.js";
import { Setup } from "./components/Setup.js";
import { ChatApp } from "./components/ChatApp.js";
import { OpenClawInstallWizard } from "./components/OpenClawInstallWizard.js";
import { clearSudoGrants } from "./components/SudoGate.js";

type State =
  | { kind: "loading" }
  | { kind: "anon"; mode: LoginMode }
  | { kind: "needs-setup"; user: User }
  | { kind: "needs-openclaw"; user: User }
  | { kind: "ready"; user: User };

function normalizeLoginMode(mode: string): LoginMode {
  return mode === "shared-secret" ? "shared-secret" : "real-auth";
}

// localStorage flag set when the user explicitly skips the install wizard;
// honoring it keeps every page-load from re-prompting after they choose to
// configure manually.
const SKIP_KEY = "clawhq.installWizardSkipped";

async function needsOpenclawWizard(): Promise<boolean> {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem(SKIP_KEY)) return false;
  } catch { /* private mode — fall through */ }
  try {
    const status = await systemApi.openclaw();
    return !status.installed;
  } catch {
    // If the relay's own /api/system/openclaw fails we can't gate on it; let
    // the user through and let the in-app Settings → OpenClaw tab handle it.
    return false;
  }
}

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    void (async () => {
      try {
        const { user, runTunnel } = await api.meExtended();
        if (await needsOpenclawWizard()) {
          setState({ kind: "needs-openclaw", user });
          return;
        }
        // Single-host deployments (relay + tunnel in one process) never need
        // manual pairing. Only show Setup when the tunnel is remote AND no
        // pairing token has been issued yet.
        if (runTunnel) {
          setState({ kind: "ready", user });
          return;
        }
        const tokens = await api.listPairingTokens();
        if (tokens.length === 0) setState({ kind: "needs-setup", user });
        else setState({ kind: "ready", user });
      } catch {
        const mode = await api.detectAuthMode();
        setState({ kind: "anon", mode: normalizeLoginMode(mode) });
      }
    })();
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="auth-shell">
        <div className="spinner" />
      </div>
    );
  }

  if (state.kind === "anon") {
    return (
      <Login
        mode={state.mode}
        onAuthenticated={async (user) => {
          if (await needsOpenclawWizard()) {
            setState({ kind: "needs-openclaw", user });
            return;
          }
          try {
            const { runTunnel } = await api.meExtended();
            if (runTunnel) {
              setState({ kind: "ready", user });
              return;
            }
          } catch { /* fall through to legacy gate */ }
          const tokens = await api.listPairingTokens();
          if (tokens.length === 0) setState({ kind: "needs-setup", user });
          else setState({ kind: "ready", user });
        }}
      />
    );
  }

  if (state.kind === "needs-openclaw") {
    return (
      <OpenClawInstallWizard
        onSkip={() => {
          try { localStorage.setItem(SKIP_KEY, String(Date.now())); } catch { /* private mode */ }
          setState({ kind: "ready", user: state.user });
        }}
        onReady={() => setState({ kind: "ready", user: state.user })}
      />
    );
  }

  if (state.kind === "needs-setup") {
    return (
      <Setup
        user={state.user}
        onDone={() => setState({ kind: "ready", user: state.user })}
      />
    );
  }

  return (
    <ChatApp
      user={state.user}
      onLogout={async () => {
        clearSudoGrants();
        await api.logout();
        const mode = await api.detectAuthMode();
        setState({ kind: "anon", mode: normalizeLoginMode(mode) });
      }}
    />
  );
}
