#!/usr/bin/env bash
# Proves check-dco.sh accepts signed work and rejects unsigned work, including
# the bot, merge-commit, and moved-base cases the gate has to get right.
set -euo pipefail

check="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-dco.sh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

expect_ok() {
  local label=$1 base_ref=$2 out
  if ! out="$(bash "$check" "$base_ref" HEAD 2>&1)"; then
    echo "DCO check test: ${label} — a valid branch was rejected" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

expect_reject() {
  local label=$1 base_ref=$2 out
  if out="$(bash "$check" "$base_ref" HEAD 2>&1)"; then
    echo "DCO check test: ${label} — an unsigned branch was accepted" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

assert_contains() {
  local label=$1 needle=$2 haystack=$3
  if ! printf '%s\n' "$haystack" | grep -qF -e "$needle"; then
    echo "DCO check test: ${label} — output missing '${needle}'" >&2
    printf '%s\n' "$haystack" >&2
    exit 1
  fi
}

mkdir -p "$tmpdir/repo"
cd "$tmpdir/repo"
git init --quiet -b main
git config user.name "Ada Contributor"
git config user.email "ada@example.com"
git config commit.gpgsign false

echo base > file.txt
git add file.txt
git commit --quiet -s -m "base commit"
base="$(git rev-parse HEAD)"

branch() { git checkout --quiet -B "$1" "$base"; }

# A signed commit passes.
branch signed
echo signed >> file.txt
git commit --quiet -a -s -m "signed change"
out="$(expect_ok "signed commit" "$base")"
assert_contains "signed commit" "DCO OK" "$out"

# An unsigned commit is rejected, with the expected trailer in the message.
branch unsigned
echo unsigned >> file.txt
git commit --quiet -a -m "unsigned change"
out="$(expect_reject "unsigned commit" "$base")"
assert_contains "unsigned commit" \
  "Signed-off-by: Ada Contributor <ada@example.com>" "$out"
assert_contains "unsigned commit" "git rebase --signoff" "$out"

# A sign-off that does not match the commit author is rejected.
branch mismatch
echo mismatch >> file.txt
git commit --quiet -a -s --author="Bo Other <bo@example.com>" -m "mismatched sign-off"
out="$(expect_reject "mismatched sign-off" "$base")"
assert_contains "mismatched sign-off" \
  "Signed-off-by: Bo Other <bo@example.com>" "$out"

# Trailer matching is case-insensitive.
branch lowercase
echo lowercase >> file.txt
git commit --quiet -a -m "lowercase trailer

signed-off-by: Ada Contributor <ada@example.com>"
expect_ok "lowercase trailer" "$base" > /dev/null

# A bot cannot run `git commit -s`, so bot-authored commits are skipped in the
# unenforced local-heuristic mode (no DCO_BOT_SHAS set).
branch bot
echo bot >> file.txt
git commit --quiet -a \
  --author="dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>" \
  -m "bump a dependency"
out="$(expect_ok "bot author" "$base")"
assert_contains "bot author" "(bot author)" "$out"

# CI mode (DCO_BOT_SHAS set): a local author name is attacker-controlled
# before push — a human faking "[bot]" in their own commit must NOT skip the
# check just because the name heuristic would have matched it.
branch spoofed_bot
echo spoofed >> file.txt
git commit --quiet -a \
  --author="attacker[bot] <attacker@example.com>" \
  -m "unsigned commit pretending to be a bot"
if out=$(DCO_BOT_SHAS="" bash "$check" "$base" HEAD 2>&1); then
  echo "DCO check test: spoofed bot author — an unsigned branch was accepted" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
assert_contains "spoofed bot author" \
  "Signed-off-by: attacker[bot] <attacker@example.com>" "$out"

# CI mode: a commit whose SHA the caller verified via the GitHub API skips,
# regardless of what its local author name says.
branch verified_bot
echo verified >> file.txt
git commit --quiet -a --author="Some Human <human@example.com>" \
  -m "commit the API says is bot-authored"
verified_sha="$(git rev-parse HEAD)"
if ! out=$(DCO_BOT_SHAS="$verified_sha" bash "$check" "$base" HEAD 2>&1); then
  echo "DCO check test: API-verified bot sha — a verified bot commit was rejected" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
assert_contains "API-verified bot sha" "(bot author)" "$out"

# Merge commits are generated, not authored, so they are skipped.
branch feature
echo feature >> file.txt
git commit --quiet -a -s -m "feature work"
branch merged
echo parallel > other.txt
git add other.txt
git commit --quiet -s -m "parallel work"
git merge --quiet --no-ff --no-edit feature
expect_ok "unsigned merge commit" "$base" > /dev/null

# When the base branch has moved ahead, its own commits are not re-checked.
git checkout --quiet -B main "$base"
echo main-only > main-only.txt
git add main-only.txt
git commit --quiet -m "unsigned commit on the base branch"
branch behind-base
echo behind >> file.txt
git commit --quiet -a -s -m "signed work off an older base"
expect_ok "base branch ahead" main > /dev/null

echo "DCO check-script test passed"
