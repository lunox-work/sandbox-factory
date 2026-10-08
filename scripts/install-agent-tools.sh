#!/usr/bin/env bash
# Installs the optional agent maintenance tools, which are not committed:
#
#   Archify         pinned upstream release, unpacked into .agents/skills/archify
#   Diagram Design  pinned upstream commit, unpacked into .agents/skills/diagram-design
#   Graphify        pinned venv and code graph in an external cache (scripts/graphify.sh)
#
#   scripts/install-agent-tools.sh                  install all three
#   scripts/install-agent-tools.sh archify          or: diagram-design, graphify
#
# Re-running is safe: a skill is replaced only when its pin changed.
set -euo pipefail

# tt-a1i/archify v3.0.1. Change the version and commit together.
ARCHIFY_VERSION="3.0.1"
ARCHIFY_COMMIT="2ab3cae7ac2c2a55d7386ca789d03c4fcd31816c"

# cathrynlavery/diagram-design 2.6.68. Change the version and commit together.
DIAGRAM_DESIGN_VERSION="2.6.68"
DIAGRAM_DESIGN_COMMIT="f4547ee95f88e5b28a52517feff6b6c11cc657f9"

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

# Only the skill directory: the repository's plugin manifests, gallery and
# maintainer scripts are not what an agent reads.
diagram_design() {
  local dest="$ROOT/.agents/skills/diagram-design"
  if [ "$(cat "$dest/.installed-commit" 2>/dev/null)" = "$DIAGRAM_DESIGN_COMMIT" ]; then
    echo "Diagram Design $DIAGRAM_DESIGN_VERSION already installed."
    return
  fi
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "https://codeload.github.com/cathrynlavery/diagram-design/tar.gz/$DIAGRAM_DESIGN_COMMIT" |
    tar -xz -C "$tmp" --strip-components=2 "diagram-design-$DIAGRAM_DESIGN_COMMIT/skills/diagram-design"
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  mv "$tmp/diagram-design" "$dest"
  rm -rf "$tmp"
  echo "$DIAGRAM_DESIGN_COMMIT" >"$dest/.installed-commit"
  echo "Installed Diagram Design $DIAGRAM_DESIGN_VERSION into ${dest#"$ROOT"/}."
}

graphify() {
  "$ROOT/scripts/graphify.sh" refresh
}

case "${1:-all}" in
  all)
    archify
    diagram_design
    graphify
    ;;
  archify) archify ;;
  diagram-design) diagram_design ;;
  graphify) graphify ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
