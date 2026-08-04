#!/usr/bin/env bash
set -euo pipefail

# Proves the cascade read-path on OKF-local sources: section/field merge with
# provenance, vertical precedence, and per-section suppression. Conflict
# surfacing is covered in Task 5; heterogeneous (MCP) stitch in source-test.sh.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
resolver="$repo_root/resolver.mjs"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fail() { echo "FAIL: $1" >&2; [ "${2:-}" ] && echo "$2" >&2; exit 1; }

company="$tmpdir/company"; team="$tmpdir/team"; personal="$tmpdir/personal"
mkdir -p "$company/decisions" "$team/decisions" "$personal/scratch"

cat > "$company/decisions/primary-db.md" <<'EOF'
---
type: decision
title: Primary database
updated: 2026-01-10
---

## Engine

Postgres.

## Backups

Nightly snapshots to cold storage.
EOF

cat > "$team/decisions/primary-db.md" <<'EOF'
---
type: decision
title: Primary database
updated: 2026-05-01
---

## Engine

SingleStore (chosen for HTAP workloads).
EOF

cat > "$tmpdir/layers.json" <<'EOF'
{
  "layers": [
    { "name": "personal", "level": 3, "path": "personal" },
    { "name": "team",     "level": 2, "path": "team" },
    { "name": "company",  "level": 0, "path": "company" }
  ]
}
EOF

resolved="$(node "$resolver" --manifest "$tmpdir/layers.json" --concept decisions/primary-db)"

grep -q 'SingleStore'     <<<"$resolved" || fail "Team override of Engine did not win" "$resolved"
grep -q 'Nightly snapshots' <<<"$resolved" || fail "Company Backups section was not inherited" "$resolved"
grep -q '"sourceLayer": "team"'    <<<"$resolved" || fail "missing team provenance" "$resolved"
grep -q '"sourceLayer": "company"' <<<"$resolved" || fail "missing company provenance" "$resolved"

# --- Per-section suppression: {#anchor override=none} tombstone (KEPT) ---
sup_company="$tmpdir/sup-company"; sup_team="$tmpdir/sup-team"
mkdir -p "$sup_company/decisions" "$sup_team/decisions"

cat > "$sup_company/decisions/retention.md" <<'EOF'
---
type: decision
title: Data retention
updated: 2026-01-01
---

## Policy {#policy}

Retain all logs for 90 days.

## Exceptions {#exceptions}

PII may be purged earlier on request.
EOF

cat > "$sup_team/decisions/retention.md" <<'EOF'
---
type: decision
title: Data retention
updated: 2026-06-01
---

## Exceptions {#exceptions override=none}
EOF

cat > "$tmpdir/sup-layers.json" <<'EOF'
{ "layers": [
  { "name": "team", "level": 2, "path": "sup-team" },
  { "name": "company", "level": 0, "path": "sup-company" }
] }
EOF

sup="$(node "$resolver" --manifest "$tmpdir/sup-layers.json" --concept decisions/retention)"
grep -q 'Retain all logs' <<<"$sup" || fail "suppression — Policy should be inherited" "$sup"
if grep -q 'PII may be purged' <<<"$sup"; then fail "suppression — Exceptions should be suppressed" "$sup"; fi
grep -q '"suppressed": true' <<<"$sup" || fail "suppression — suppressed section needs suppressed=true for audit" "$sup"

# --- Conflict surfacing: dissent attached per section with layer + date ---
conf_company="$tmpdir/conf-company"; conf_team="$tmpdir/conf-team"
mkdir -p "$conf_company/decisions" "$conf_team/decisions"

cat > "$conf_company/decisions/database-engine.md" <<'EOF'
---
type: decision
title: Database engine
updated: 2026-06-01
---

## Engine {#engine}

Postgres (org standard).
EOF

cat > "$conf_team/decisions/database-engine.md" <<'EOF'
---
type: decision
title: Database engine
updated: 2026-05-12
---

## Engine {#engine}

SingleStore (HTAP / reporting).
EOF

cat > "$tmpdir/conf-layers.json" <<'EOF'
{ "layers": [
  { "name": "team", "level": 2, "path": "conf-team" },
  { "name": "company", "level": 0, "path": "conf-company" }
] }
EOF

conf="$(node "$resolver" --manifest "$tmpdir/conf-layers.json" --concept decisions/database-engine)"
grep -q 'SingleStore' <<<"$conf" || fail "conflict — team primary should win the Engine section" "$conf"
grep -q '"conflicts"' <<<"$conf" || fail "conflict — resolved section should carry a conflicts array" "$conf"
grep -q 'Postgres' <<<"$conf" || fail "conflict — company dissent value should be surfaced" "$conf"
grep -q '"layer": "company"' <<<"$conf" || fail "conflict — dissent should name the company layer" "$conf"
grep -q '2026-06-01' <<<"$conf" || fail "conflict — dissent should carry the company updated date" "$conf"
# The company dissent (2026-06-01) is newer than the effective team value
# (2026-05-12): the section must carry the freshness flag, and the flag must
# never change who wins — precedence stays level-based.
grep -q '"fresherDissent": true' <<<"$conf" || fail "freshness — newer dissent should set fresherDissent" "$conf"
grep -q '"sourceLayer": "team"' <<<"$conf" || fail "freshness — the flag must not change the winner" "$conf"

# --- Formatting equivalence: formatting noise is not dissent -------------------
# Positive table: trailing whitespace/tabs, unordered-bullet glyph (* -> -, with
# indentation preserved), and blank-line runs are formatting, not disagreement.
printf '%s\n' \
  '---' 'type: decision' 'title: Rollout order' 'updated: 2026-01-10' '---' '' \
  '## Rollout {#rollout}' '' \
  'We deploy on Tuesdays.' '' \
  '- canary first' '  - nested step' \
  > "$conf_company/decisions/format-noise.md"
{
  printf '%s\n' '---' 'type: decision' 'title: Rollout order' 'updated: 2026-05-12' '---' '' \
    '## Rollout {#rollout}' ''
  printf 'We deploy on Tuesdays.\t\n'
  printf '%s\n' '' '' '* canary first' '  * nested step'
} > "$conf_team/decisions/format-noise.md"

noise="$(node "$resolver" --manifest "$tmpdir/conf-layers.json" --concept decisions/format-noise)"
if grep -q '"conflicts"' <<<"$noise"; then fail "equivalence — formatting-only dissent must be suppressed" "$noise"; fi
if grep -q '"fresherDissent"' <<<"$noise"; then fail "equivalence — dropped dissent must not drive the freshness flag" "$noise"; fi
grep -q 'canary first' <<<"$noise" || fail "equivalence — team content should still win" "$noise"

# Negative table: case, ordered-list markers (1. vs 1)), and reordered list
# items change meaning — they must stay conflicts.
printf '%s\n' \
  '---' 'type: decision' 'title: Meaningful differences' 'updated: 2026-01-10' '---' '' \
  '## Casing {#casing}' '' 'postgres is the standard.' '' \
  '## Steps {#steps}' '' '1. install' '2. run' '' \
  '## Order {#order}' '' '- alpha' '- beta' \
  > "$conf_company/decisions/format-meaning.md"
printf '%s\n' \
  '---' 'type: decision' 'title: Meaningful differences' 'updated: 2026-05-12' '---' '' \
  '## Casing {#casing}' '' 'Postgres is the standard.' '' \
  '## Steps {#steps}' '' '1) install' '2) run' '' \
  '## Order {#order}' '' '- beta' '- alpha' \
  > "$conf_team/decisions/format-meaning.md"

meaning="$(node "$resolver" --manifest "$tmpdir/conf-layers.json" --concept decisions/format-meaning)"
node -e '
const resolved = JSON.parse(process.argv[1]);
const contested = resolved.sections.filter((s) => s.conflicts && s.conflicts.length).map((s) => s.key);
for (const key of ["casing", "steps", "order"]) {
  if (!contested.includes(key)) throw new Error("meaningful difference must stay a conflict: " + key + " (contested: " + contested.join(",") + ")");
}
' "$meaning" || fail "equivalence — case/ordered-marker/reorder differences must stay conflicts" "$meaning"

# --- Freshness flag edge cases: drive mergeConcepts directly so dates are exact ---
# (Disk fixtures cannot produce a null date in a plain folder — the mtime
# fallback dates them — so the null/unparseable/datetime cases go straight in.)
cat > "$tmpdir/freshness.mjs" <<EOF
import { mergeConcepts } from "$repo_root/packages/core/src/resolver.mjs";
const contributor = (layer, level, updated, content) => ({
  layer, level, updated,
  frontmatter: {},
  sections: [{ key: "engine", heading: "## Engine", updated: null, lines: [content] }],
});
const flag = (winnerUpdated, dissentUpdated) => {
  const merged = mergeConcepts([
    contributor("team", 2, winnerUpdated, "SingleStore."),
    contributor("company", 0, dissentUpdated, "Postgres."),
  ]);
  const section = merged.sections[0];
  if (section.content !== "SingleStore." || section.sourceLayer !== "team") {
    throw new Error("freshness flag must never change the winner: " + JSON.stringify(section));
  }
  return section.fresherDissent === true;
};
const cases = [
  ["dissent strictly newer by day", true, "2026-05-12", "2026-06-01"],
  ["datetime vs same-day date-only must not flag", false, "2026-05-12", "2026-05-12T23:59:59Z"],
  ["equal dates must not flag", false, "2026-05-12", "2026-05-12"],
  ["null winner date must not flag", false, null, "2026-06-01"],
  ["null dissent date must not flag", false, "2026-05-12", null],
  ["unparseable dissent date must not flag", false, "2026-05-12", "sometime last week"],
  ["older dissent must not flag", false, "2026-06-01", "2026-05-12"],
];
for (const [description, expected, winnerUpdated, dissentUpdated] of cases) {
  const got = flag(winnerUpdated, dissentUpdated);
  if (got !== expected) throw new Error(description + ": expected " + expected + ", got " + got);
}
console.log("ok");
EOF
freshness="$(node "$tmpdir/freshness.mjs")"
[ "$freshness" = "ok" ] || fail "fresherDissent edge cases" "$freshness"

# --- Commit dates: an undated section reports when the CONTENT last changed ---
# An okf-local bundle is a git repo, and git does not preserve mtimes — a clone
# stamps every file with the clone time. If the section date came from the mtime,
# a decision written in 2019 would present as written today, in the field the
# cascade offers as the staleness signal. It must be the last-commit date.

gitrepo="$tmpdir/gitrepo"; mkdir -p "$gitrepo/decisions" "$gitrepo/nested/decisions"
cat > "$gitrepo/decisions/legacy.md" <<'EOF'
---
type: decision
title: Legacy decision
---

## Engine

MySQL. Written years ago, never re-dated.
EOF
# A layer rooted at a subdirectory of the repo: git reports paths from the repo
# root, so this is the shape that silently falls back to mtime if the adapter
# forgets to account for its own prefix.
cp "$gitrepo/decisions/legacy.md" "$gitrepo/nested/decisions/legacy.md"
git -C "$gitrepo" init -q .
git -C "$gitrepo" config user.email test@example.com
git -C "$gitrepo" config user.name Test
git -C "$gitrepo" add -A
# Author date 2019, committer date today — the shape `git pull --rebase` leaves
# behind, and git-core runs exactly that as its divergence recovery. Reading the
# committer date would re-date the whole bundle to today on the flow team-sync
# depends on, so the author date is the one that must win.
GIT_COMMITTER_DATE="2026-01-15T12:00:00" git -C "$gitrepo" commit -q --date="2019-03-01T12:00:00" -m "the original decision"
# What a clone/checkout does to the mtime.
touch "$gitrepo/decisions/legacy.md" "$gitrepo/nested/decisions/legacy.md"

# An uncommitted sibling: no commit date exists, and there the mtime IS the real
# edit time — the same signal a files layer uses for a plain folder.
cp "$gitrepo/decisions/legacy.md" "$gitrepo/decisions/uncommitted.md"

cat > "$tmpdir/git-layers.json" <<'EOF'
{ "layers": [ { "name": "team", "level": 2, "path": "gitrepo" } ] }
EOF
cat > "$tmpdir/git-nested-layers.json" <<'EOF'
{ "layers": [ { "name": "team", "level": 2, "path": "gitrepo/nested" } ] }
EOF

dated="$(node "$resolver" --manifest "$tmpdir/git-layers.json" --concept decisions/legacy)"
grep -q '"sourceUpdated": "2019-03-01"' <<<"$dated" || fail "an undated section in a git bundle should carry the last-commit date, not the mtime" "$dated"

nested="$(node "$resolver" --manifest "$tmpdir/git-nested-layers.json" --concept decisions/legacy)"
grep -q '"sourceUpdated": "2019-03-01"' <<<"$nested" || fail "a layer rooted in a subdirectory of a repo should still get commit dates" "$nested"

untracked="$(node "$resolver" --manifest "$tmpdir/git-layers.json" --concept decisions/uncommitted)"
grep -q "\"sourceUpdated\": \"$(date +%Y-%m-%d)\"" <<<"$untracked" || fail "an uncommitted doc has no commit date and should fall back to its mtime" "$untracked"

# Concurrent reads must agree with sequential ones. mcp-server does not await its
# request handler, so reads overlap; a history memo published before its own
# await would leave every concurrent reader with the mtime instead.
cat > "$tmpdir/concurrent.mjs" <<EOF
import { createOkfLocalSource } from "$repo_root/packages/core/src/sources/okf-local.mjs";
const ids = ["decisions/legacy", "decisions/legacy", "decisions/legacy"];
const source = createOkfLocalSource({ name: "team", level: 2, root: "$gitrepo" });
const loaded = await Promise.all(ids.map((id) => source.loadConcept(id)));
console.log(JSON.stringify(loaded.map((c) => c.sections[0].updated)));
EOF
concurrent="$(node "$tmpdir/concurrent.mjs")"
[ "$concurrent" = '["2019-03-01","2019-03-01","2019-03-01"]' ] || fail "concurrent loads should all get the commit date, not the mtime" "$concurrent"

# A shallow clone's boundary commit lists the whole tree as added at the
# truncation date. Dating from it would claim every file was written at clone
# time — mtime's lie by another route — so those sections stay undated.
git clone -q --depth 1 "file://$gitrepo" "$tmpdir/shallow"
cat > "$tmpdir/shallow-layers.json" <<'EOF'
{ "layers": [ { "name": "team", "level": 2, "path": "shallow" } ] }
EOF
shallow="$(node "$resolver" --manifest "$tmpdir/shallow-layers.json" --concept decisions/legacy)"
grep -q '"sourceUpdated": null' <<<"$shallow" || fail "a shallow clone cannot date its history and must say so, not invent the boundary date" "$shallow"

# A git that fails inside a real repo means the dates are unknown — it does not
# make the mtime trustworthy. Falling back to it here would date every doc today,
# which is the failure this whole path exists to prevent.
mkdir -p "$tmpdir/shim"
cat > "$tmpdir/shim/git" <<EOF
#!/bin/sh
# Absolute path: the shim is first on PATH, so a bare \`git\` would re-enter it.
if [ "\$3" = "log" ]; then echo "simulated git failure" >&2; exit 128; fi
exec "$(command -v git)" "\$@"
EOF
chmod +x "$tmpdir/shim/git"
broken="$(PATH="$tmpdir/shim:$PATH" node "$resolver" --manifest "$tmpdir/git-layers.json" --concept decisions/legacy 2>/dev/null)"
grep -q '"sourceUpdated": null' <<<"$broken" || fail "an unreadable git history should leave sections undated, not fall back to the mtime" "$broken"

# --- Path-traversal guard: a concept id must not escape its layer root ---
for evil in ".." "../secrets" "decisions/../../etc/passwd" "a/.." "/etc/passwd"; do
  if node "$resolver" --manifest "$tmpdir/conf-layers.json" --concept "$evil" 2>/dev/null; then
    fail "path-traversal id '$evil' should be rejected, not resolved"
  fi
done

echo "resolver test passed (section merge + provenance + vertical precedence + suppression + conflicts + equivalence + freshness + commit dates + traversal guard)"
