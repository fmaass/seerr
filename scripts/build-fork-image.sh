#!/usr/bin/env bash
# Build the Seerr fork image and stamp it with the exact commit it was built from,
# so a running container can always be traced back to a revision in this repo.
set -euo pipefail

IMAGE_NAME=seerr-radarr-blocklist
SOURCE_URL=https://github.com/fmaass/seerr

usage() {
  cat <<'EOU'
Usage: scripts/build-fork-image.sh <version-tag>

Builds the fork image for linux/amd64 from the COMMITTED tree at HEAD (never the
working directory) and tags it seerr-radarr-blocklist:<version-tag>, e.g. 3.4.1-fms.1.

The build is refused unless the worktree is clean and HEAD is on a v*-upgrade branch,
because the image is stamped with HEAD's SHA and that stamp must describe the whole
image. The SHA is passed as the COMMIT_TAG build arg (it lands in committag.json) and
recorded in the org.opencontainers.image.revision label, which is read back after the
build; org.opencontainers.image.source records the fork's repository.
EOU
}

case "${1-}" in
  -h | --help)
    usage
    exit 0
    ;;
  "")
    usage >&2
    echo "error: missing <version-tag>" >&2
    exit 2
    ;;
esac

VERSION_TAG=$1
IMAGE_REF="$IMAGE_NAME:$VERSION_TAG"

# A dirty tree would produce an image whose revision label does not describe its contents.
# --untracked-files=all so a user's status.showUntrackedFiles setting cannot hide a
# stray file from the check.
DIRTY=$(git status --porcelain --untracked-files=all)
if [ -n "$DIRTY" ]; then
  echo "error: worktree is not clean; commit or remove these before building:" >&2
  printf '%s\n' "$DIRTY" >&2
  exit 2
fi

# Release images come only from the upgrade branches; a detached HEAD has no branch
# name here and is refused with them.
BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)
case "$BRANCH" in
  v*-upgrade) ;;
  *)
    echo "error: HEAD is on '${BRANCH:-(detached)}', not a v*-upgrade branch; refusing to build" >&2
    exit 2
    ;;
esac

SHA=$(git rev-parse HEAD)

# Records the id of the image this run produced, so the read-back cannot be satisfied
# by some other image that happens to carry the tag.
IIDFILE=$(mktemp)
trap 'rm -f "$IIDFILE"' EXIT

# The context is git's own archive of the captured commit on stdin: ignored and
# untracked files (.env.production.local and friends) cannot reach the builder, and
# the content cannot drift from the stamp if HEAD moves during the build.
git archive --format=tar "$SHA" |
  docker build \
    --platform linux/amd64 \
    --build-arg COMMIT_TAG="$SHA" \
    --label org.opencontainers.image.revision="$SHA" \
    --label org.opencontainers.image.source="$SOURCE_URL" \
    -t "$IMAGE_REF" \
    --iidfile "$IIDFILE" \
    -

BUILT_ID=$(cat "$IIDFILE")
echo "built $IMAGE_REF ($BUILT_ID) from $SHA"

STAMPED=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$BUILT_ID")
if [ "$STAMPED" != "$SHA" ]; then
  echo "error: revision label on $BUILT_ID is '$STAMPED', expected '$SHA'" >&2
  exit 1
fi

TAGGED_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_REF")
if [ "$TAGGED_ID" != "$BUILT_ID" ]; then
  echo "error: $IMAGE_REF points at '$TAGGED_ID', not the image just built ('$BUILT_ID')" >&2
  exit 1
fi
echo "revision label verified on $BUILT_ID: $STAMPED"
