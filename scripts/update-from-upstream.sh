#!/usr/bin/env bash
# Bring this copy of NoteFlare up to date with the original repository.
#
# A copy made by the "Deploy to Cloudflare" button has its own history and its own settings
# in wrangler.jsonc (database id, Cloudflare Access values). This takes the new code, keeps
# those settings, and records the result as one ordinary commit. It does not push.
#
#   scripts/update-from-upstream.sh                      # from homielab/noteflare, branch main
#   UPSTREAM=you/fork scripts/update-from-upstream.sh
#
# How it merges:
# - Code: your own changes are kept where they don't overlap with upstream's; where both
#   changed the same lines, or one deleted a file the other changed, upstream wins. On the
#   first update everything comes from upstream.
# - wrangler.jsonc: yours, plus what changed upstream; where both changed the same lines, yours wins.
# - .github/workflows: left exactly as they are (KEEP_WORKFLOWS=1, used by the Update workflow,
#   whose token is not allowed to change workflow files).
#
# The upstream commit this copy is based on is remembered in .noteflare-upstream.
set -euo pipefail

UPSTREAM="${UPSTREAM:-homielab/noteflare}"
BRANCH="${UPSTREAM_BRANCH:-main}"
KEEP_WORKFLOWS="${KEEP_WORKFLOWS:-0}"
MARKER=".noteflare-upstream"

if [ -n "$(git status --porcelain)" ]; then
  echo "There are uncommitted changes. Commit or discard them first." >&2
  exit 1
fi

git fetch --quiet "${UPSTREAM_URL:-https://github.com/${UPSTREAM}.git}" "$BRANCH"
theirs="$(git rev-parse FETCH_HEAD)"

# The upstream commit the last update was based on: the marker, or shared history if there is any.
base=""
if [ -f "$MARKER" ]; then base="$(tr -d '[:space:]' < "$MARKER")"; fi
if [ -z "$base" ] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  base="$(git merge-base HEAD "$theirs" 2>/dev/null || true)"
fi

if [ "$base" = "$theirs" ]; then
  echo "Already up to date."
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -r "$work"' EXIT

# Settings first, from the committed files, before the working tree changes.
git show HEAD:wrangler.jsonc > "$work/wrangler.jsonc"
if [ -n "$base" ] && git show "$base:wrangler.jsonc" > "$work/base" 2>/dev/null; then
  git show "$theirs:wrangler.jsonc" > "$work/theirs"
  git merge-file --ours "$work/wrangler.jsonc" "$work/base" "$work/theirs" >/dev/null || true
fi

# Code: a three-way merge computed without touching history.
# Exit status 1 means conflicts -X theirs can't settle: a file one side deleted and the other
# changed (e.g. a workflow file the Deploy button left out), renames, a file vs a directory.
# Those paths are listed after the tree id and settled below; other statuses are errors.
status=0
if [ -n "$base" ]; then
  git merge-tree --write-tree -z --name-only -X theirs --merge-base="$base" HEAD "$theirs" > "$work/merge" || status=$?
else
  git merge-tree --write-tree -z --name-only -X theirs --allow-unrelated-histories HEAD "$theirs" > "$work/merge" || status=$?
fi
tree=""
conflicts=()
if [ "$status" -le 1 ]; then
  {
    IFS= read -r -d '' tree || true
    while IFS= read -r -d '' path && [ -n "$path" ]; do conflicts+=("$path"); done
  } < "$work/merge"
fi
if [ -z "$tree" ]; then
  echo "The update could not be merged automatically. Update by hand: https://noteflare.homielab.com/start/update/" >&2
  exit 1
fi

git read-tree -u --reset "$tree"

# Where a conflict is left, upstream wins: its version of the file, or no file if it deleted it.
for path in ${conflicts[@]+"${conflicts[@]}"}; do
  if git cat-file -e "$theirs:$path" 2>/dev/null; then
    git checkout --quiet "$theirs" -- "$path"
  else
    git rm -r --quiet --force --ignore-unmatch -- "$path"
  fi
done

cp "$work/wrangler.jsonc" wrangler.jsonc
printf '%s\n' "$theirs" > "$MARKER"
git add wrangler.jsonc "$MARKER"

if [ "$KEEP_WORKFLOWS" = "1" ]; then
  git rm -r --quiet --force --ignore-unmatch .github/workflows
  if [ -n "$(git ls-tree -r --name-only HEAD -- .github/workflows)" ]; then
    git checkout --quiet HEAD -- .github/workflows
  fi
fi

version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
git commit --quiet -m "Update NoteFlare to ${version} (${theirs:0:7})"
echo "Updated to NoteFlare ${version} (${theirs:0:7})."
