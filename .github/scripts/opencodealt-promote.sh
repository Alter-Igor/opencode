#!/usr/bin/env bash
# Fork-only (#97): promote a soaked opencodealt EDGE release (GitHub pre-release) to STABLE
# (a normal release marked Latest). Same files; nothing is rebuilt.
#
# Automatic rule: the newest opencodealt release is promoted when it is a pre-release, has been
# out at least SOAK_DAYS, and no open issue has the label `release-hold`. "Newest" means no newer
# edge build has landed since, so a busy week simply waits for things to go quiet.
#
# Manual: TAG=<opencodealt-v...> promotes that release now (skips soak and hold). Pointing TAG at an
# older release rolls stable back to it.
#
# Env: GH_TOKEN, REPO (owner/name), SOAK_DAYS (default 3), TAG (optional), DRY_RUN=1 (report only).
set -euo pipefail

REPO="${REPO:?REPO is required}"
SOAK_DAYS="${SOAK_DAYS:-3}"
TAG="${TAG:-}"
PREFIX="opencodealt-v"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

say() { echo "$1"; echo "$1" >> "$summary"; }

stable="$(gh api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null || echo none)"

if [ -n "$TAG" ]; then
  case "$TAG" in "$PREFIX"*) ;; *) say "FAIL: $TAG is not an opencodealt release tag."; exit 1 ;; esac
  gh release view "$TAG" --repo "$REPO" --json tagName >/dev/null
  candidate="$TAG"
  why="manual promotion (soak and hold skipped)"
else
  holds="$(gh issue list --repo "$REPO" --label release-hold --state open --json number --jq 'length')"
  if [ "$holds" -gt 0 ]; then
    say "HOLD: $holds open issue(s) labelled release-hold. Stable stays $stable."
    exit 0
  fi
  newest="$(gh api "repos/$REPO/releases?per_page=50" --jq "
    [ .[] | select(.draft | not) | select(.tag_name | startswith(\"$PREFIX\")) ]
    | sort_by(.published_at) | last // empty
    | [.tag_name, (.prerelease | tostring), .published_at] | @tsv")"
  if [ -z "$newest" ]; then
    say "Nothing to do: no opencodealt releases found."
    exit 0
  fi
  IFS=$'\t' read -r tag prerelease published <<< "$newest"
  if [ "$prerelease" != "true" ]; then
    say "Nothing to do: the newest release $tag is already stable."
    exit 0
  fi
  age_hours=$(( ( $(date -u +%s) - $(date -u -d "$published" +%s) ) / 3600 ))
  if [ "$age_hours" -lt $(( SOAK_DAYS * 24 )) ]; then
    say "Waiting: newest edge $tag is ${age_hours}h old; it needs $(( SOAK_DAYS * 24 ))h with no newer edge. Stable stays $stable."
    exit 0
  fi
  # Never let the automatic path move stable backwards (only a manual TAG may roll back).
  if [ "$stable" != "none" ] && [ "$stable" != "null" ]; then
    stable_v="${stable#"$PREFIX"}"
    edge_v="${tag#"$PREFIX"}"
    highest="$(printf '%s\n%s\n' "$stable_v" "$edge_v" | sort -V | tail -n 1)"
    if [ "$edge_v" = "$stable_v" ] || [ "$highest" != "$edge_v" ]; then
      say "Nothing to do: edge $tag is not newer than stable $stable."
      exit 0
    fi
  fi
  candidate="$tag"
  why="soaked ${age_hours}h with no newer edge build and no release-hold"
fi

if [ "${DRY_RUN:-}" = "1" ]; then
  say "DRY RUN: would promote $candidate to stable ($why). Stable is $stable."
  exit 0
fi

gh release edit "$candidate" --repo "$REPO" --prerelease=false --latest
now="$(gh api "repos/$REPO/releases/latest" --jq .tag_name)"
if [ "$now" != "$candidate" ]; then
  say "FAIL: promoted $candidate, but GitHub's Latest release is $now."
  exit 1
fi
say "Promoted $candidate to stable ($why). Was $stable."
