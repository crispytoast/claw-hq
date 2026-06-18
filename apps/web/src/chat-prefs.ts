/**
 * Per-device chat preferences. Persisted in localStorage so they survive
 * reloads but stay per-device (different from server-side chat metadata).
 *
 * Phase 9.1: fast-mode default toggle. When on, new chats created from
 * Sidebar / ChatApp pass `mode: "fast"` to clawhq.chats.create.
 */

const KEY_FAST_MODE_DEFAULT = "clawhq.fast_mode_default";

export function getFastModeDefault(): boolean {
  try {
    return window.localStorage.getItem(KEY_FAST_MODE_DEFAULT) === "true";
  } catch {
    return false;
  }
}

export function setFastModeDefault(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY_FAST_MODE_DEFAULT, "true");
    else window.localStorage.removeItem(KEY_FAST_MODE_DEFAULT);
  } catch {
    /* localStorage may be disabled in private mode; ignore */
  }
}
