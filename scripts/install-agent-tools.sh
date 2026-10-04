#!/usr/bin/env bash
# Installs the optional agent maintenance tools, which are not committed:
#
#   Archify   pinned upstream release, unpacked into .agents/skills/archify
#   Graphify  pinned venv and code graph in an external cache (scripts/graphify.sh)
#
#   scripts/install-agent-tools.sh             install both
#   scripts/install-agent-tools.sh archify     or: graphify
#
# Re-running is safe: Archify is replaced only when its pin changed.
set -euo pipefail

# tt-a1i/archify v3.0.1. Change the version and commit together.
ARCHIFY_VERSION="3.0.1"
ARCHIFY_COMMIT="2ab3cae7ac2c2a55d7386ca789d03c4fcd31816c"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.agents/skills/archify"

archify() {
  if [ "$(cat "$DEST/.installed-commit" 2>/dev/null)" = "$ARCHIFY_COMMIT" ]; then
    echo "Archify $ARCHIFY_VERSION already installed."
  else
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "https://codeload.github.com/tt-a1i/archify/tar.gz/$ARCHIFY_COMMIT" |
      tar -xz -C "$tmp" --strip-components=1 "archify-$ARCHIFY_COMMIT/archify"
    rm -rf "$DEST"
    mkdir -p "$(dirname "$DEST")"
    mv "$tmp/archify" "$DEST"
    echo "$ARCHIFY_COMMIT" >"$DEST/.installed-commit"
    echo "Installed Archify $ARCHIFY_VERSION into ${DEST#"$ROOT"/}."
  fi
  ARCHIFY_UPDATE_CHECK_DISABLED=1 node "$DEST/bin/archify.mjs" doctor | tail -1
}

graphify() {
  "$ROOT/scripts/graphify.sh" refresh
}

case "${1:-all}" in
  all)
    archify
    graphify
    ;;
  archify) archify ;;
  graphify) graphify ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
