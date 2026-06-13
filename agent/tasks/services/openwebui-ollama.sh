#!/usr/bin/env bash
set -Eeuo pipefail

source "$(dirname "$0")/../lib/core-bridge.sh"
run_v4_core "services/ollama/install.sh"
