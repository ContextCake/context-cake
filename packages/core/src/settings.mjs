// Engine settings: the knobs that used to be environment-only. They live in
// the manifest (`"settings": { ... }`) so the app can offer a normal settings
// screen — nobody should have to edit an env file to index a bigger folder.
//
// Precedence, highest first:
//   1. manifest.settings.<key>   — what the settings UI writes
//   2. process.env.<ENV>         — headless/CI override, and the pre-UI default
//   3. def.default               — the shipped sensible default
//
// The manifest wins over the environment on purpose: if a stray env var
// outranked the UI, changing a setting in the app would silently do nothing.
// Dependency-free, like the rest of packages/core.

export const SETTING_DEFS = {
  maxDocFiles: {
    default: 10_000,
    min: 100,
    max: 2_000_000,
    env: "CONTEXTCAKE_MAX_DOC_FILES",
    label: "Maximum documents per source",
    help: "How many .md/.mdx/.txt files ContextCake will index in one folder before it stops and asks for a more specific folder.",
  },
  maxScanEntries: {
    default: 150_000,
    min: 1_000,
    max: 20_000_000,
    env: "CONTEXTCAKE_MAX_SCAN_ENTRIES",
    label: "Maximum files scanned per source",
    help: "How many files and folders ContextCake will look through while searching for documents. Raise this for deep folder trees.",
  },
  sourceBudgetMs: {
    default: 30_000,
    min: 1_000,
    max: 600_000,
    env: "CONTEXTCAKE_SOURCE_BUDGET_MS",
    label: "Time budget per source",
    help: "How long one source may take to index before it is marked unavailable. Raise this for slow network drives.",
  },
};

export const SETTING_KEYS = Object.keys(SETTING_DEFS);

function fromEnv(def) {
  const value = Number(process.env[def.env]);
  // Environment overrides are also useful for tightly bounded tests and
  // constrained deployments, so accept positive values below the UI minimum.
  // Still enforce the safety ceiling: an env var must not bypass the cap.
  return Number.isFinite(value) && value > 0 && value <= def.max
    ? Math.round(value)
    : null;
}

/** The effective settings for a manifest: manifest value, else env, else default. */
export function resolveSettings(manifest = {}) {
  const stored = manifest?.settings ?? {};
  const out = {};
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    const value = Number(stored[key]);
    const inRange = Number.isFinite(value) && value >= def.min && value <= def.max;
    out[key] = inRange ? Math.round(value) : (fromEnv(def) ?? def.default);
  }
  return out;
}

/** Walk limits in the shape walkDocs() takes. */
export function walkLimitsFrom(settings) {
  return { maxFiles: settings.maxDocFiles, maxEntries: settings.maxScanEntries };
}

/**
 * Validate a settings patch from the API. Returns the accepted subset; throws
 * a plain Error naming the offending field so the caller can 400 it. An empty
 * patch is valid (a no-op save), but an unknown key is not — a typo in a
 * setting name must not silently do nothing.
 */
export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Settings must be an object");
  }
  const clean = {};
  for (const [key, raw] of Object.entries(patch)) {
    const def = SETTING_DEFS[key];
    if (!def) throw new Error(`Unknown setting: ${key}`);
    if (raw === null) continue; // explicit "reset to default" — drop the stored value
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${def.label} must be a number`);
    if (value < def.min || value > def.max) {
      throw new Error(`${def.label} must be between ${def.min.toLocaleString("en-US")} and ${def.max.toLocaleString("en-US")}`);
    }
    clean[key] = Math.round(value);
  }
  return clean;
}

/** The catalog the settings UI renders (labels, help, ranges, defaults). */
export function settingsCatalog() {
  return Object.entries(SETTING_DEFS).map(([key, def]) => ({
    key,
    label: def.label,
    help: def.help,
    min: def.min,
    max: def.max,
    default: def.default,
  }));
}
