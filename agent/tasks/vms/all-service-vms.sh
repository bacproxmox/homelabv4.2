#!/usr/bin/env bash
set -Eeuo pipefail

source "$(dirname "$0")/../lib/core-bridge.sh"
run_v4_core "vms/vm102-docker-arr/create.sh"
run_v4_core "vms/vm103-network/create.sh"
run_v4_core "vms/vm104-nextcloud/create.sh"
run_v4_core "vms/vm105-homeassistant/create.sh"
run_v4_core "vms/vm106-docker-media/create.sh"
run_v4_core "vms/vm107-chia-farmer/create.sh"
run_v4_core "vms/vm110-pbs-backup/create.sh"
