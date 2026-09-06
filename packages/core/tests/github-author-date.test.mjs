import test from "node:test";
import assert from "node:assert/strict";
import { createGithubSource } from "../src/sources/github.mjs";

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
