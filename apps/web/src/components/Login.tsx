import { useState } from "react";
import { api, type User } from "../api.js";

export type LoginMode = "shared-secret" | "real-auth";

interface Props {
  mode?: LoginMode;
  onAuthenticated(user: User): void | Promise<void>;
}

export function Login({ mode = "real-auth", onAuthenticated }: Props) {
  if (mode === "shared-secret") {
    return <SharedSecretLogin onAuthenticated={onAuthenticated} />;
  }
  return <RealAuthLogin onAuthenticated={onAuthenticated} />;
}

function SharedSecretLogin({ onAuthenticated }: Props) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const user = await api.loginSharedSecret(password);
      await onAuthenticated(user);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1>
          <span className="brand-dot" />
          Claw HQ
        </h1>
        <p className="sub">Enter the shared passphrase to sign in.</p>

        <div className="field">
          <label>Passphrase</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
          />
        </div>

        <div className="err">{err || " "}</div>

        <div className="row">
          <span />
          <button type="submit" className="btn-primary" disabled={busy || !password}>
            {busy ? <span className="spinner" /> : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}

function RealAuthLogin({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const user = mode === "login"
        ? await api.login(email, password)
        : await api.signup(email, password, displayName);
      await onAuthenticated(user);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h1>
          <span className="brand-dot" />
          Claw HQ
        </h1>
        <p className="sub">
          {mode === "login" ? "Sign in to your account." : "Create a new account."}
        </p>

        {mode === "signup" && (
          <div className="field">
            <label>Display name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Frank"
              autoComplete="name"
            />
          </div>
        )}

        <div className="field">
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value.toLowerCase())}
            placeholder="you@example.com"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="email"
          />
        </div>

        <div className="field">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "login" ? "" : "at least 8 characters"}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </div>

        <div className="err">{err || " "}</div>

        <div className="row">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
          >
            {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <span className="spinner" /> : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </div>
      </form>
    </div>
  );
}
