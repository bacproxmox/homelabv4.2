# v4 Backend Structure (Separation from Legacy v3)

This folder is the forward path for Homelab **v4.x** runtime logic.
`backend/v3.0/` is kept as **legacy compatibility** for stable recovery and
historical behavior while v4 scripts are cleaned and standardized one-by-one.

## Design Rules (v4.x)

1. **One concern per file**
   - VM create, service install, service config, repair, and health checks should be
     separated into their own script files.
2. **No hidden orchestration**
   - A flow/task should compose smaller scripts, not contain many unrelated steps.
3. **Version boundary**
   - All new v4 work should be added under `agent/core/backend/v4/...`.
   - `agent/core/backend/v3.0` remains legacy and should only be edited for bug fixes
     or migration support.
4. **Script contract**
   - Every script is idempotent where possible.
   - Every script should emit clear progress logs and return non-zero on hard failures.
5. **Manifest alignment**
   - If behavior is exposed in UI, it must be represented in
     `agent/manifests/script-catalog.json` and/or `agent/manifests/guided-steps.json`.

## v4 Migration State

- `v4`: new logic target (goes here).
- `v3.0`: legacy implementation imported from previous releases and currently used as
  compatibility fallback.

### Immediate next actions

1. Build a migration map: `v3.0` path ↔ new `v4` path.
2. Add wrapper scripts for legacy parity where needed.
3. Switch UI manifests to `v4` targets progressively without changing user flow.
4. Keep dual-path fallback until each high-risk item has been validated.

