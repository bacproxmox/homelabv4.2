#!/usr/bin/env bash
set -Eeuo pipefail

V4_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HOMELAB_V4_BACKEND="$(cd "$V4_LIB_DIR/.." && pwd)"
export HOMELAB_ROOT="${HOMELAB_ROOT:-$(cd "$HOMELAB_V4_BACKEND/../.." && pwd)}"
export HOMELAB_BACKEND_VERSION="${HOMELAB_BACKEND_VERSION:-v4}"

source "$HOMELAB_ROOT/lib/core/runner.sh"

v4_task_name() {
  local script="${BASH_SOURCE[1]:-$0}"
  printf '%s\n' "${script#$HOMELAB_ROOT/}"
}

v4_start() {
  local name="${1:-$(v4_task_name)}"
  echo "Homelabv4 task: $name"
}

v4_run_legacy() {
  local legacy_target="$1"
  shift || true
  v4_start "$(v4_task_name)"
  echo "Compatibility target: $legacy_target"
  homelab_run "$legacy_target" "$@"
}

