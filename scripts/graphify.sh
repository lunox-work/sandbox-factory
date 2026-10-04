#!/usr/bin/env bash
# Maintenance code graph for navigating this repository. Local AST extraction
# only: no model calls, and nothing is written into the checkout. The venv and
# graph live in an external cache. This is separate from the product worker's
# Graphify pin (apps/worker/python/requirements.lock); do not align the two.
#
#   scripts/graphify.sh refresh            build or incrementally update the graph
#   scripts/graphify.sh query "<terms>"    also: path, explain (args pass through)
set -euo pipefail

VERSION="0.9.74" # graphifyy on PyPI; source tag v0.9.74
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${GRAPHIFY_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/sandbox-factory/graphify}"
BIN="$CACHE/venv/bin/graphify"
GRAPH="$CACHE/graphify-out/graph.json"

# Without these the CLI may rewrite installed assistant skills and log queries.
export GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_QUERY_LOG_DISABLE=1

install() {
  if [ -x "$BIN" ] && [ "$(cat "$CACHE/venv/.version" 2>/dev/null)" = "$VERSION" ]; then
    return
  fi
  rm -rf "$CACHE/venv"
  mkdir -p "$CACHE"
  python3 -m venv "$CACHE/venv"
  "$CACHE/venv/bin/pip" install --quiet "graphifyy==$VERSION"
  echo "$VERSION" >"$CACHE/venv/.version"
}

refresh() {
  install
  # --code-only skips semantic inputs. --no-label stops cluster-only from
  # picking an available model to name communities.
  "$BIN" extract "$ROOT" --code-only --no-dedup --out "$CACHE"
  "$BIN" cluster-only "$CACHE" --no-label --no-viz
  echo "Graph: $GRAPH"
  echo "Report: $CACHE/graphify-out/GRAPH_REPORT.md"
}

command="${1:-}"
case "$command" in
  refresh)
    refresh
    ;;
  query | path | explain)
    shift
    [ -f "$GRAPH" ] || refresh >&2
    "$BIN" "$command" "$@" --graph "$GRAPH"
    ;;
  *)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
