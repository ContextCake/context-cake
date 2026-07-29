#!/usr/bin/env bash
# Verify that every commit in a range carries a Developer Certificate of Origin
# sign-off trailer matching its author. Plain bash + git, no third-party action:
# the contributor gate should not add a supply-chain surface the engine refuses
# to add for itself.
#
# Usage: check-dco.sh <base-ref> [head-ref]
#
# Merge commits are skipped — they are generated, not authored. Commits authored
# by a bot are skipped because a bot cannot execute `git commit -s`; this matches
# the default behavior of GitHub's DCO app and keeps Dependabot PRs mergeable.
set -euo pipefail

base=${1:?usage: check-dco.sh <base-ref> [head-ref]}
head=${2:-HEAD}

# A PR-merge or shallow checkout may not contain the base commit yet.
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  git fetch --no-tags --quiet origin "$base" 2>/dev/null || true
fi

if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "Could not resolve base commit ${base}." >&2
  exit 1
fi

# Compare against the fork point so commits already on the base branch are not
# re-checked when the base has moved ahead.
range_start="$(git merge-base "$base" "$head" 2>/dev/null || echo "$base")"

failed=0
checked=0
skipped=0

while IFS= read -r sha; do
  [ -n "$sha" ] || continue

  author_name="$(git show -s --format='%an' "$sha")"
  author_email="$(git show -s --format='%ae' "$sha")"
  subject="$(git show -s --format='%s' "$sha")"
  short="$(git rev-parse --short "$sha")"

  case "$author_name" in
    *'[bot]')
      echo "skip  ${short}  ${subject}  (bot author)"
      skipped=$((skipped + 1))
      continue
      ;;
  esac

  checked=$((checked + 1))
  expected="Signed-off-by: ${author_name} <${author_email}>"

  if git show -s --format='%B' "$sha" | grep -qiF -e "$expected"; then
    echo "ok    ${short}  ${subject}"
  else
    echo "FAIL  ${short}  ${subject}"
    echo "      missing trailer: ${expected}"
    failed=$((failed + 1))
  fi
done < <(git rev-list --no-merges "${range_start}..${head}")

if [ "$failed" -gt 0 ]; then
  echo >&2
  echo "${failed} commit(s) are missing a sign-off matching their author." >&2
  echo >&2
  echo "Every commit must certify the Developer Certificate of Origin (see ./DCO)" >&2
  echo "with a trailer that matches the commit author exactly:" >&2
  echo >&2
  echo "  Signed-off-by: Your Name <your@email>" >&2
  echo >&2
  echo "To fix the most recent commit:" >&2
  echo "  git commit --amend --signoff --no-edit" >&2
  echo >&2
  echo "To fix every commit on this branch:" >&2
  echo "  git rebase --signoff ${base}" >&2
  echo >&2
  echo "Then update the pull request:" >&2
  echo "  git push --force-with-lease" >&2
  exit 1
fi

echo "DCO OK — ${checked} commit(s) signed off, ${skipped} skipped."
