#!/usr/bin/env bash
set -Eeuo pipefail

source "$(dirname "$0")/../lib/core-bridge.sh"
run_v4_core "services/docker/prepare-all-hosts.sh"
run_v4_core "services/arr/install.sh"
run_v4_core "services/seerr/install.sh"
run_v4_core "services/uptime-kuma/install.sh"
run_v4_core "services/nextcloud/install.sh"
run_v4_core "services/jellyfin/install.sh"
run_v4_core "services/immich/install.sh"
run_v4_core "services/ollama/install.sh"
run_v4_core "services/lidarr/install.sh"
run_v4_core "services/homeassistant/install.sh"
run_v4_core "services/pbs/install.sh"
