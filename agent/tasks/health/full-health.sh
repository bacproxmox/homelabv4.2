#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/../lib/core-bridge.sh"
if [[ -x /opt/homelabv4/core/bin/homelab || -f /opt/homelabv4/core/bin/homelab ]]; then
  run_v4_core "health/full.sh"
fi
echo "===== Agent-level health ====="
systemctl status homelab-agent.service --no-pager || true
curl -fsS http://127.0.0.1:48114/api/v1/health || true
