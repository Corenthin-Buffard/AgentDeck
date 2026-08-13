#!/usr/bin/env bash
# Is main's VERSION actually published, or is the install URL serving something older?
#
# WHY THIS EXISTS: `release.yml` fires on a tag, and pushing that tag is a human
# step. It was forgotten for v0.2.5.0 and again for v0.2.5.1, so
# releases/latest served a binary two feature releases behind while the README
# told people to curl exactly that URL. Nothing noticed. This is the noticing.
#
# It detects; it never publishes. Cutting a release is a decision, not a
# mechanical consequence of a merge.
#
# The logic lives here rather than inline in ci.yml because the CI job only runs
# on main, so no pull request can ever exercise it — its branches would be tested
# nowhere. Parameterised, they are all drivable from a test. Same reason
# 46f489f moved the agent launch command out of the spawn call.

set -euo pipefail

VERSION_IN=""
PUBLISHED_IN=""
RELEASED_AGO_IN=""
MAX_AGE=3   # a Friday merge tagged on Monday must not turn main red

usage() {
  cat <<'EOF'
Usage: check-release-current.sh [options]

  --version V         the version to check      (default: the VERSION file)
  --published TAG     the published release tag (default: ask the GitHub API)
                      TAG | none | unknown
  --released-days-ago N   age of the published release (default: from the API)
  --max-age-days N        grace window                 (default: 3)
  -h, --help          this text

Exit 0 when the release is current, when the drift is younger than the grace
window, or when the API could not answer. Exit 1 only for drift that has been
sitting past the window — the state nobody is acting on.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)      VERSION_IN="${2:?--version needs a value}"; shift 2 ;;
    --published)    PUBLISHED_IN="${2:?--published needs a value}"; shift 2 ;;
    --released-days-ago) RELEASED_AGO_IN="${2:?--released-days-ago needs a value}"; shift 2 ;;
    --max-age-days) MAX_AGE="${2:?--max-age-days needs a value}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

VERSION="${VERSION_IN:-$(cat VERSION)}"

# NEVER conclude from a non-answer. A rate-limited API, an expired token or a
# GitHub outage must not become "you forgot to release" — that would send the
# operator to tag a version that is already published. Only an explicit
# "release not found" counts as a real absence; everything else is `unknown`.
if [ -n "$PUBLISHED_IN" ]; then
  PUBLISHED="$PUBLISHED_IN"
elif out="$(gh release view --json tagName,publishedAt -q '.tagName + " " + .publishedAt' 2>&1)"; then
  PUBLISHED="${out%% *}"
  PUBLISHED_AT="${out#* }"
else
  case "$out" in
    *"elease not found"*|*"o releases found"*|*"not find any release"*) PUBLISHED="none" ;;
    *) PUBLISHED="unknown" ;;
  esac
fi

# Measure the age of the PUBLISHED RELEASE, not of the VERSION bump. Measuring
# the bump was the first cut and it is wrong: every bump resets the clock, so a
# project that ships often never accumulates age and the guard never fires — even
# while the install URL stays permanently behind. The real drift here lasted two
# days across THREE versions, and no single version was ever unpublished for
# three. What matters is how long it has been since anything was released.
if [ -n "$RELEASED_AGO_IN" ]; then
  AGE="$RELEASED_AGO_IN"
elif [ -n "${PUBLISHED_AT:-}" ]; then
  rel_at="$(date -d "$PUBLISHED_AT" +%s 2>/dev/null || echo "")"
  if [ -n "$rel_at" ]; then AGE=$(( ( $(date +%s) - rel_at ) / 86400 )); else AGE=0; fi
else
  # Never released at all: fall back to how long this VERSION has existed, so a
  # brand-new repo is not red on its first commit.
  bumped_at="$(git log -1 --format=%ct -- VERSION 2>/dev/null || true)"
  if [ -n "$bumped_at" ]; then AGE=$(( ( $(date +%s) - bumped_at ) / 86400 )); else AGE=0; fi
fi

if [ "$PUBLISHED" = "unknown" ]; then
  echo "cannot reach the releases API — not concluding whether v$VERSION is published"
  exit 0
fi

if [ "$PUBLISHED" = "v$VERSION" ]; then
  echo "current: v$VERSION is the published release"
  exit 0
fi

if [ "$AGE" -lt "$MAX_AGE" ]; then
  echo "v$VERSION is not published yet (latest is $PUBLISHED, cut ${AGE}d ago) — within the ${MAX_AGE}d grace window"
  exit 0
fi

echo "main is at $VERSION but the last release, $PUBLISHED, was cut ${AGE}d ago."
echo "The README tells people to curl releases/latest, so that URL is serving $PUBLISHED."
echo "Cut the release:"
echo "    git tag v$VERSION && git push origin v$VERSION"
exit 1
