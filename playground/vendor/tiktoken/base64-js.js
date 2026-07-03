// Minimal `base64-js` shim (js-tiktoken only needs toByteArray).
// Tokenization runs server-side in Node, so decode via the built-in Buffer.
export function toByteArray(b64) {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}
export function fromByteArray(bytes) {
  return Buffer.from(bytes).toString("base64");
}
export function byteLength(b64) {
  return Buffer.from(b64, "base64").length;
}
export default { toByteArray, fromByteArray, byteLength };
