#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V4_DIR="$SCRIPT_DIR"
while [[ ! -f "$V4_DIR/lib/task.sh" && "$V4_DIR" != "/" ]]; do
  V4_DIR="$(cd "$V4_DIR/.." && pwd)"
done
[[ -f "$V4_DIR/lib/task.sh" ]] || { echo "Homelabv4 task library not found." >&2; exit 127; }
source "$V4_DIR/lib/task.sh"

v4_run_legacy "config/pbs/01-pbs-backup-automation.sh" "$@"