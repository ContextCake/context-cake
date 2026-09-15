import test from "node:test";
import assert from "node:assert/strict";
import { createGithubSource, trimTrailingSlashes } from "../src/sources/github.mjs";

test("GitHub sections use author date; rebases and unrelated pushes cannot make guidance newer", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let history = { author: { date: "2025-02-03T12:30:00Z" }, committer: { date: "2026-09-06T12:00:00Z" } };
  let forbidden = false;
  globalThis.fetch = async url => {
    if (url.pathname.endsWith("/commits")) return forbidden ? new Response("Forbidden", { status: 403 })
      : new Response(JSON.stringify(history ? [{ commit: history }] : []));
    if (url.pathname.includes("/contents/")) return new Response("# Database\n\n## Choice\n\nUse Postgres.");
    if (url.pathname.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [{ type: "blob", path: "README.md", size: 50 }] }));
    return new Response(JSON.stringify({ default_branch: "main", pushed_at: "2026-09-06T12:00:00Z" }));
  };
  const source = createGithubSource({ name: "repo", level: 1, repo: "org/project", paths: ["README.md"] });
  const dates = async () => (await source.loadConcept("org/project/README")).sections.map(section => section.updated);
  assert.ok((await dates()).every(date => date === "2025-02-03"));
  history = { committer: { date: "2026-09-06T12:00:00Z" } }; source.sync();
  assert.ok((await dates()).every(date => date == null), "committer-only history is undated");
  history = null; source.sync();
  assert.ok((await dates()).every(date => date == null), "empty history does not use repository pushed_at");
  forbidden = true; source.sync();
  assert.ok((await dates()).every(date => date == null), "unavailable history keeps readable content undated");
});

test("apiBase drops trailing slashes exactly as the regex it replaced, in linear time", () => {
  // The old regex, as the specification. It rescanned an inner slash run from
  // each slash in it (ReDoS), and apiBase comes from the manifest.
  const TRAILING_SLASHES = /\/+$/;
  assert.equal(trimTrailingSlashes("https://ghe.example/api/v3///"), "https://ghe.example/api/v3");
  const pieces = ["/", "//", "a", ".", " ", "\n"];
  let state = 11;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 16;
  for (let i = 0; i < 50_000; i += 1) {
    let value = "";
    for (let length = next() % 12; length > 0; length -= 1) value += pieces[next() % pieces.length];
    assert.equal(trimTrailingSlashes(value), value.replace(TRAILING_SLASHES, ""), JSON.stringify(value));
  }

  const hostile = `https://ghe.example${"/".repeat(200_000)}x`;
  const started = performance.now();
  assert.equal(trimTrailingSlashes(hostile), hostile);
  createGithubSource({ name: "repo", level: 1, repo: "org/project", apiBase: hostile });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5_000, `a hostile apiBase took ${Math.round(elapsed)} ms`);
});
