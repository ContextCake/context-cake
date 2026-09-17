// Typed control-plane errors (specs/contextcake-control-plane/design.md §3).
//
// A ControlError carries a stable machine `code` alongside the HTTP status its
// service adapter answers with; `detail` rides the same field http-util's
// error serializer already spreads into the response body, so an operation
// extracted from an HTTP handler keeps producing the responses it did — plus
// a `code` field, which the service adds for ControlErrors only so a client
// can branch on it rather than on the wording of the message. Non-HTTP
// adapters (the CLI) map `code`/`status` onto exit categories and the JSON
// envelope instead of a response body.

export class ControlError extends Error {
  constructor(code, message, { status = 500, detail = null, retryable = false, exit = null } = {}) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.status = status;
    if (detail != null) this.detail = detail;
    this.retryable = retryable;
    // An explicit exit category wins over the code and status tables below.
    if (exit != null) this.exit = exit;
  }
}

// CLI exit codes (control-plane spec §5.2). The numbers are contract once a
// family is marked stable: agents branch on them instead of on prose.
export const EXIT_CATEGORIES = Object.freeze({
  ok: 0,
  internal: 1,
  "invalid-input": 2,
  "not-found": 3,
  conflict: 4,
  permission: 5,
  unavailable: 6,
  integrity: 7,
  unhealthy: 8,
  interrupted: 130,
});

// Codes whose category is not what their HTTP status alone would say, plus the
// codes the CLI adapter itself raises. A code missing here falls back to its
// status, so an operation extracted from a handler needs no entry unless its
// status misleads (a 409 that really means "recovery required", say).
export const CODE_CATEGORIES = Object.freeze({
  INTERNAL: "internal",
  INVALID_INPUT: "invalid-input",
  UNKNOWN_COMMAND: "invalid-input",
  TIMEOUT_REFUSED: "invalid-input",
  NOT_FOUND: "not-found",
  MANIFEST_NOT_FOUND: "not-found",
  PROFILE_NOT_FOUND: "not-found",
  SOURCE_NOT_FOUND: "not-found",
  RULE_NOT_FOUND: "not-found",
  MAPPING_NOT_FOUND: "not-found",
  CONFIRMATION_REQUIRED: "conflict",
  STALE_REVISION: "conflict",
  STALE: "conflict",
  PROFILE_EXISTS: "conflict",
  PROFILE_ACTIVE: "conflict",
  PROFILE_PROTECTED: "conflict",
  MANIFEST_NOT_V2: "conflict",
  PROJECT_MAPPED: "conflict",
  PERMISSION_DENIED: "permission",
  UNTRUSTED_SOURCE: "permission",
  PATH_OUTSIDE_LAYER: "permission",
  CREDENTIAL_BACKEND_UNAVAILABLE: "permission",
  UNAVAILABLE: "unavailable",
  TIMEOUT: "unavailable",
  MANIFEST_LOCKED: "unavailable",
  INCOMPLETE_COVERAGE: "unavailable",
  GIT_UNAVAILABLE: "unavailable",
  // Source and settings operations (control/sources.mjs, control/settings.mjs).
  // Their HTTP statuses stay as they were; these rows are the CLI's reading.
  NAME_INVALID: "invalid-input",
  NAME_REQUIRED: "invalid-input",
  LEVEL_INVALID: "invalid-input",
  POSITION_INVALID: "invalid-input",
  LEVEL_AND_POSITION: "invalid-input",
  PATH_REQUIRED: "invalid-input",
  PATHS_INVALID: "invalid-input",
  NOT_A_FOLDER: "invalid-input",
  KIND_UNKNOWN: "invalid-input",
  REPO_INVALID: "invalid-input",
  SUBDIR_ESCAPES: "invalid-input",
  REST_AUTH_REJECTED: "invalid-input",
  MCP_COMMAND_REQUIRED: "invalid-input",
  MCP_CONTRACT: "invalid-input",
  ORDER_INVALID: "invalid-input",
  PATCH_REFUSED: "invalid-input",
  SYNC_UNSUPPORTED: "invalid-input",
  PENDING_INCOMPLETE: "invalid-input",
  PENDING_INVALID: "invalid-input",
  SETTINGS_INVALID: "invalid-input",
  FOLDER_NOT_FOUND: "not-found",
  REPO_NOT_FOUND: "not-found",
  REPO_NOT_PUBLIC: "not-found",
  PENDING_NOT_FOUND: "not-found",
  SOURCE_EXISTS: "conflict",
  NAME_EXISTS: "conflict",
  CLONE_DIR_OCCUPIED: "conflict",
  CLONE_MISSING: "conflict",
  API_BASE_UNCONFIRMED: "permission",
  REORDER_BLOCKED: "conflict",
  REMOVE_BLOCKED: "conflict",
  MCP_TRUST_REQUIRED: "permission",
  MCP_UNREACHABLE: "unavailable",
  GIT_FAILED: "unavailable",
  SYNC_FAILED: "unavailable",
  MANIFEST_UNREPAIRABLE: "integrity",
  MANIFEST_INVALID: "integrity",
  RECOVERY_REQUIRED: "integrity",
  ROLLED_BACK: "integrity",
  SIDECAR_CONFLICT: "integrity",
  UNHEALTHY_DIAGNOSTICS: "unhealthy",
  INTERRUPTED: "interrupted",
});

function categoryForStatus(status) {
  if (status === 400 || status === 413 || status === 422) return "invalid-input";
  if (status === 401 || status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  return "internal";
}

export function exitCategoryFor(error) {
  if (error?.exit && Object.hasOwn(EXIT_CATEGORIES, error.exit)) return error.exit;
  if (error?.code && Object.hasOwn(CODE_CATEGORIES, error.code)) return CODE_CATEGORIES[error.code];
  return categoryForStatus(error?.status);
}

export function exitCodeFor(error) {
  return EXIT_CATEGORIES[exitCategoryFor(error)];
}

// Anything thrown below an adapter becomes a ControlError here. Plain errors
// from Node (ENOENT, EACCES) and the engine's own timeout code keep their
// meaning; everything else is internal, and its message is kept so a human
// can act on it (the adapter redacts before it prints).
export function toControlError(error) {
  if (error instanceof ControlError) return error;
  const message = error?.message ? String(error.message) : String(error);
  if (error?.code === "ENOENT") return new ControlError("NOT_FOUND", message, { status: 404 });
  if (error?.code === "EACCES" || error?.code === "EPERM") return new ControlError("PERMISSION_DENIED", message, { status: 403 });
  if (error?.code === "CONTEXTCAKE_TIMEOUT") return new ControlError("TIMEOUT", message, { status: 504, retryable: true });
  return new ControlError("INTERNAL", message, { status: 500 });
}

// manifest.mjs throws plain Errors whose wording is pinned by tests. This maps
// the ones an adapter must branch on to stable codes, keeping the message.
// An errno error keeps its Node meaning; any other plain error from a manifest
// read or strict write is a validation failure, which needs a human to repair
// the file (exit 7), not a retry.
export function manifestControlError(error) {
  if (error instanceof ControlError) return error;
  const message = error?.message ? String(error.message) : String(error);
  if (/^ContextCake manifest does not exist/.test(message)) return new ControlError("MANIFEST_NOT_FOUND", message, { status: 404 });
  if (/^Timed out acquiring the ContextCake manifest lock/.test(message)) return new ControlError("MANIFEST_LOCKED", message, { status: 503, retryable: true });
  if (/^Unknown ContextCake profile/.test(message)) return new ControlError("PROFILE_NOT_FOUND", message, { status: 404 });
  if (/^Invalid ContextCake profile id/.test(message)) return new ControlError("INVALID_INPUT", message, { status: 400 });
  if (/requires? (?:migration to )?Manifest v2/.test(message)) return new ControlError("MANIFEST_NOT_V2", message, { status: 409 });
  if (error?.code) return toControlError(error);
  return new ControlError("MANIFEST_INVALID", message, { status: 422, exit: "integrity" });
}
