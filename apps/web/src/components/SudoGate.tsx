import { useEffect, useState, useCallback } from "react";
import { Lock, Warning } from "./icons.js";

/**
 * In-app sudo prompt for operator.admin-scoped operations. This is a defense
 * layer on top of OpenClaw's scope checks — the gateway still rejects calls
 * without the right scope. Here we just give the user a confirmation modal so
 * an accidental tap on "Uninstall" or "Remove paired device" doesn't fire.
 *
 * The pattern is a global singleton: a single mounted <SudoGate /> listens for
 * window events; any component anywhere calls `requireSudo({title, body, verb})`
 * and awaits the user's decision.
 *
 * Lightweight TTL grant: if the user checks "don't ask again for 5 min", we
 * remember consent for that exact `title` key in sessionStorage. Cleared on
 * logout (clear sessionStorage) or refresh by the user manually.
 */

const GRANT_TTL_MS = 5 * 60_000;

export interface SudoRequest {
  /** Short verb / title — also used as the cache key for "don't ask again". */
  title: string;
  /** Longer prose describing what's about to happen. */
  body: string;
  /** The label on the Confirm button. Defaults to "Confirm". */
  verb?: string;
  /** Danger styling on the Confirm button. */
  danger?: boolean;
}

interface PendingRequest extends SudoRequest {
  resolve(allowed: boolean): void;
}

interface SudoEventDetail {
  request: SudoRequest;
  resolve(allowed: boolean): void;
}

const EVENT = "clawhq-sudo-required";

function grantKey(title: string): string {
  return `clawhq.sudo.grant.${title}`;
}

function hasFreshGrant(title: string): boolean {
  try {
    const raw = sessionStorage.getItem(grantKey(title));
    if (!raw) return false;
    const at = Number.parseInt(raw, 10);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < GRANT_TTL_MS;
  } catch {
    return false;
  }
}

function recordGrant(title: string): void {
  try {
    sessionStorage.setItem(grantKey(title), String(Date.now()));
  } catch { /* private mode */ }
}

/**
 * Pop the sudo modal and resolve to true/false. Returns true immediately if
 * the user already granted this title within the last 5 minutes.
 *
 * Safe to call from any component — it talks to <SudoGate /> via a window
 * event so there's no React context to thread through.
 */
export function requireSudo(req: SudoRequest): Promise<boolean> {
  if (hasFreshGrant(req.title)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const detail: SudoEventDetail = { request: req, resolve };
    window.dispatchEvent(new CustomEvent(EVENT, { detail }));
  });
}

/**
 * Clear every cached sudo grant — call from the logout path so a new user on
 * the same machine doesn't inherit prior consent.
 */
export function clearSudoGrants(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith("clawhq.sudo.grant.")) keys.push(k);
    }
    for (const k of keys) sessionStorage.removeItem(k);
  } catch { /* private mode */ }
}

export function SudoGate() {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [rememberFor, setRememberFor] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SudoEventDetail>).detail;
      if (!detail) return;
      setPending({ ...detail.request, resolve: detail.resolve });
      setRememberFor(false);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  // ESC + click-out cancel; trap focus inside the modal otherwise.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        pending.resolve(false);
        setPending(null);
      } else if (e.key === "Enter") {
        // Enter confirms only if it didn't originate inside an editable input
        // we don't actually have inside this modal, but be defensive.
        const tgt = e.target as HTMLElement | null;
        if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
        confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, rememberFor]);

  const confirm = useCallback(() => {
    if (!pending) return;
    if (rememberFor) recordGrant(pending.title);
    pending.resolve(true);
    setPending(null);
  }, [pending, rememberFor]);

  const cancel = useCallback(() => {
    if (!pending) return;
    pending.resolve(false);
    setPending(null);
  }, [pending]);

  if (!pending) return null;
  return (
    <div className="sudo-backdrop" onClick={cancel}>
      <div className="sudo-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sudo-modal-icon">{pending.danger ? <Warning size={22} /> : <Lock size={22} />}</div>
        <div className="sudo-modal-title">{pending.title}</div>
        <div className="sudo-modal-body">{pending.body}</div>
        <label className="sudo-modal-remember">
          <input
            type="checkbox"
            checked={rememberFor}
            onChange={(e) => setRememberFor(e.target.checked)}
          />
          Don't ask again for this action for 5 minutes
        </label>
        <div className="sudo-modal-actions">
          <button className="btn-ghost" onClick={cancel}>Cancel</button>
          <button
            className={pending.danger ? "btn-ghost danger" : "btn-primary"}
            onClick={confirm}
            autoFocus
          >
            {pending.verb ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
