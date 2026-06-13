import { useEffect, useState } from "react";
import { api, type User } from "./api.js";
import { Login } from "./components/Login.js";
import { Setup } from "./components/Setup.js";
import { ChatApp } from "./components/ChatApp.js";

type State =
  | { kind: "loading" }
  | { kind: "anon" }
  | { kind: "needs-setup"; user: User }
  | { kind: "ready"; user: User };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    void (async () => {
      try {
        const { user, runTunnel } = await api.meExtended();
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
        setState({ kind: "anon" });
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
        onAuthenticated={async (user) => {
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
        await api.logout();
        setState({ kind: "anon" });
      }}
    />
  );
}
