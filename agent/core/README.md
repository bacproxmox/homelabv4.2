# Homelabv4 Core Runtime

Homelabv4 uses a v4 script surface under `backend/v4`.
The imported v3 backend stays under `backend/v3.0` only as a compatibility layer
while the v4 scripts are split into smaller, single-purpose tasks.

## Start

From Proxmox, inside the package:

```bash
bash bootstrap.sh
```

Or run the runtime command directly:

```bash
bash bin/homelab tui
bash bin/homelab list
bash bin/homelab run backend/v4/vms/vm106-docker-media/create.sh
bash bin/homelab run backend/v4/services/ollama/install.sh
bash bin/homelab run backend/v4/config/post-services/run-all.sh
```

## v4 script layout

- `backend/v4/vms/<vm>/create.sh`
- `backend/v4/services/<service>/install.sh`
- `backend/v4/config/<service>/<task>.sh`
- `backend/v4/repair/<task>.sh`
- `backend/v4/health/<task>.sh`
- `backend/v4/support/<task>.sh`

The Windows agent still exposes stable panel targets under `/opt/homelabv4/agent/tasks`.
Those task wrappers now call `backend/v4/...` targets through `run_v4_core`.

## Compatibility

`backend/v4/migration-map.json` records which v4 task still delegates to a legacy
target. This keeps fresh installs usable while each script is rewritten cleanly.
New v4 work should be added under `backend/v4`, not directly under `backend/v3.0`.

Existing v3 paths remain available for recovery, but they are no longer the primary
runtime surface.

## v3.1.1 stabilization highlights

- Warning steps are retryable on resume; `warn` is no longer treated as complete.
- TrueNAS checkpoint is checked before VM create, so reruns do not revalidate passthrough disks after SSH checkpoint already passed.
- Cloudflared missing tunnel JSON has a recovery menu and remains non-critical.
- TrueNAS private disk errors now show exact recovery commands and support explicit tank-only mode via `TRUENAS_PRIVATE_REQUIRED=0`.
- Support bundles collect v3 state, VM configs, disk by-id, `lsblk`, `pvesm`, and disk-related `dmesg`.

## Logs and state

- Logs: `/root/homelab-logs/v3.1.1-r2-session-*`
- Master log: `/root/homelab-logs/v3.1.1-r2-session-*/00-v3.1.1-r2-master.log`
- State: `/root/homelabv3.1.1-r2-state/state.tsv`
- Support bundle menu: TUI option `Support bundle topla`

## v3.1.1-r2 stabilization notes

- Fixes Cloudflared final route file regeneration.
- Fixes support bundle target resolution / error 127.
- Adds support bundle wrappers under both `maintenance/logs` and `tasks/maintenance/logs`.
- Improves Chia missing plot disk diagnostics.
