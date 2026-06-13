# Homelabv4.2 Release Notes

Homelabv4.2 is the target release for the Windows Electron panel plus the
separated v4 script runtime.

## Highlights

- Electron app version aligned to `4.2.0`.
- GitHub package/repository target aligned to `homelabv4.2`.
- Script Center tasks now route through `backend/v4/...` entry points.
- `backend/v4` contains the first wave of one-task-per-file wrappers for VM,
  service, config, repair, health, and support actions.
- `backend/v4/migration-map.json` tracks which v4 entry points still delegate to
  legacy v3-compatible scripts.
- Script catalog marks core tasks as `v4-core`.

## Release Target

- Repository: `bacproxmox/homelabv4.2`
- ZIP: `homelabv4.2.zip`
- Electron semver: `4.2.0`

