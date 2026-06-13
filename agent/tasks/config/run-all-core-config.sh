#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../lib/core-bridge.sh"

export HOMELAB_NO_JELLYFIN_WIZARD_PROMPT="${HOMELAB_NO_JELLYFIN_WIZARD_PROMPT:-1}"
export HOMELAB_NO_JELLYFIN_WIZARD_GATE="${HOMELAB_NO_JELLYFIN_WIZARD_GATE:-1}"

run_v4_core "config/post-services/run-all.sh"
