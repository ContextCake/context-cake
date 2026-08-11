// Typed control-plane errors (specs/contextcake-control-plane/design.md §3).
//
// A ControlError carries a stable machine `code` alongside the HTTP status its
// service adapter answers with; `detail` rides the same field http-util's
// error serializer already spreads into the response body, so an operation
// extracted from an HTTP handler keeps producing byte-identical responses.
// Non-HTTP adapters (the CLI) map `code`/`status` onto exit categories and the
// JSON envelope instead of a response body.

export class ControlError extends Error {
  constructor(code, message, { status = 500, detail = null, retryable = false } = {}) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.status = status;
    if (detail != null) this.detail = detail;
    this.retryable = retryable;
  }
}
