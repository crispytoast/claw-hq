// Single source of truth for the Claw HQ release version. Anything that
// reports a version (system.ts, docs.ts, /docs/latest-version.json) imports
// from here so we don't drift across files.
//
// Bump on release. The GitHub release tag should match (v<VERSION>).
export const CLAW_HQ_VERSION = "0.2.1";

// Default releases endpoint that /api/system/version/check polls when
// CLAW_HQ_RELEASES_URL is not explicitly set in the environment. The repo
// is public so this works for every install out of the box.
export const DEFAULT_RELEASES_URL =
  "https://api.github.com/repos/crispytoast/claw-hq/releases/latest";
