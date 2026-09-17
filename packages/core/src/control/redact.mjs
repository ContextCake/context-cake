// Secret redaction for everything an adapter prints (control-plane spec §5.1).
//
// Three classes, each tested on its own:
//   (a) exact values obtained from a credential source (tokenEnv values, the
//       injected token map) wherever they appear;
//   (b) strings shaped like known provider tokens;
//   (c) Authorization header values, plus URL userinfo, which carries the same
//       secret in a git remote.
// Redaction runs on the value tree before serialization, so a secret inside a
// wrapped error message, a details object, or a key is caught the same way.
//
// Every pattern stays linear: a fixed prefix followed by one bounded character
// class. Error text can be attacker-shaped (a foreign MCP server's stderr).

export const REDACTED = "[redacted]";

// Exact-match scrubbing ignores very short values: a three-character "secret"
// would blank every occurrence of those letters in a path or message.
const MIN_EXACT_LENGTH = 4;

const PROVIDER_TOKEN = /(?:github_pat_|gh[pousr]_|glpat-|npm_|xox[abprs]-|sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}/g;
const AUTH_HEADER = /\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)[^\r\n"',}]+/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@:]{1,256}(?::[^\s/@]{0,256})?@/gi;
const SECRET_KEY = /^(?:authorization|proxy-authorization|password|passwd|secret|client[_-]?secret|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|cookie)$/i;

export function createRedactor(secretValues = []) {
  const exact = [...new Set(
    [...secretValues].filter((value) => typeof value === "string" && value.length >= MIN_EXACT_LENGTH),
  )].sort((a, b) => b.length - a.length); // longest first, so a value containing another is scrubbed whole

  function redactString(text) {
    let out = text;
    for (const value of exact) {
      if (out.includes(value)) out = out.split(value).join(REDACTED);
    }
    return out
      .replace(PROVIDER_TOKEN, REDACTED)
      .replace(AUTH_HEADER, (_match, name, separator) => `${name}${separator}${REDACTED}`)
      .replace(BEARER, (_match, scheme) => `${scheme} ${REDACTED}`)
      .replace(URL_USERINFO, (_match, scheme) => `${scheme}${REDACTED}@`);
  }

  // The walk yields what JSON.stringify would print, then redacts it: toJSON
  // is honored (Date, URL, Buffer), an Error keeps its name, message, and
  // code, and `ancestors` holds only the current path, so a value referenced
  // twice prints twice and only a true cycle becomes "[circular]".
  function redact(value, key = "", ancestors = new Set()) {
    if (value && typeof value === "object" && !(value instanceof Error) && typeof value.toJSON === "function") {
      value = value.toJSON(key);
    }
    if (typeof value === "string") {
      return SECRET_KEY.test(key) && value.length > 0 ? REDACTED : redactString(value);
    }
    if (!value || typeof value !== "object") return value;
    if (ancestors.has(value)) return "[circular]";
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => redact(entry, key, ancestors));
      const source = value instanceof Error
        ? { name: value.name, message: value.message, ...(value.code !== undefined ? { code: value.code } : {}), ...value }
        : value;
      const out = {};
      for (const [childKey, childValue] of Object.entries(source)) {
        if (childValue === undefined || typeof childValue === "function") continue;
        out[redactString(childKey)] = redact(childValue, childKey, ancestors);
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  }

  return { redact, redactString };
}

// Every tokenEnv value a manifest names, across all profiles and pending
// sources. Reading an env var the manifest points at is safe: the value only
// ever feeds the scrub list, never output.
export function manifestSecretValues(manifest, env = process.env) {
  const values = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const tokenEnv = node.auth?.tokenEnv;
    if (typeof tokenEnv === "string" && typeof env[tokenEnv] === "string") values.push(env[tokenEnv]);
    for (const child of Object.values(node)) visit(child);
  };
  visit(manifest);
  return values;
}
