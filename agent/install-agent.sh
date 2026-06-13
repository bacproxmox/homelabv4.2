#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/opt/homelabv4"
AGENT="$ROOT/agent"
STATE="$ROOT/state"
LOGS="$ROOT/logs"
CORE="$ROOT/core"
SERVICE="/etc/systemd/system/homelab-agent.service"
PAYLOAD_SOURCE_DIR="${HOMELABV4_PAYLOAD_SOURCE_DIR:-$AGENT}"
REPO_URL="${HOMELABV4_REPO_URL:-https://github.com/bacproxmox/homelabv4.git}"
REPO_REF="${HOMELABV4_REPO_REF:-main}"
ALLOW_GITHUB_FALLBACK="${HOMELABV4_ALLOW_GITHUB_FALLBACK:-1}"
EXPECTED_PAYLOAD_HASH="${HOMELABV4_EXPECTED_PAYLOAD_HASH:-}"

mkdir -p "$AGENT" "$STATE" "$LOGS" "$CORE"
chmod 700 "$STATE" "$LOGS"

payload_hash_for_directory() {
  local directory="$1"
  python3 - "$directory" <<'PY'
import hashlib
import pathlib
import sys


root = pathlib.Path(sys.argv[1])
exclude_names = {".payload-manifest.json"}
exclude_dirs = {"__pycache__", ".git", "node_modules"}
exclude_suffixes = {".pyc", ".pyo"}

hasher = hashlib.sha256()
file_count = 0
byte_count = 0

if not root.exists():
    print("0")
    sys.exit(0)


items = []
for path in root.rglob("*"):
    if path.is_dir():
        continue
    if path.name in exclude_names:
        continue
    if path.suffix in exclude_suffixes:
        continue
    if any(part in exclude_dirs for part in path.parts):
        continue
    items.append(path)

for path in sorted(items, key=lambda item: item.relative_to(root).as_posix()):
    rel = path.relative_to(root).as_posix()
    hasher.update(rel.encode("utf-8"))
    hasher.update(b"\0")
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
            byte_count += len(chunk)
    hasher.update(b"\0")
    file_count += 1

print(hasher.hexdigest())
print(file_count)
print(byte_count)
PY
}

if [[ "$PAYLOAD_SOURCE_DIR" != "$AGENT" ]]; then
  if [[ ! -d "$PAYLOAD_SOURCE_DIR" ]]; then
    echo "Payload source directory not found: $PAYLOAD_SOURCE_DIR"
    exit 1
  fi
fi

echo "Checking payload hash from source directory: $PAYLOAD_SOURCE_DIR"
actual_hash="$(payload_hash_for_directory "$PAYLOAD_SOURCE_DIR")"
actual_hash_value="$(printf '%s\n' "$actual_hash" | sed -n '1p')"
actual_file_count="$(printf '%s\n' "$actual_hash" | sed -n '2p')"
actual_byte_count="$(printf '%s\n' "$actual_hash" | sed -n '3p')"

if [[ -n "$EXPECTED_PAYLOAD_HASH" ]]; then
  if [[ "$actual_hash_value" != "$EXPECTED_PAYLOAD_HASH" ]]; then
    echo "Payload hash mismatch before install."
    echo "Expected: $EXPECTED_PAYLOAD_HASH"
    echo "Actual:   $actual_hash_value"
    exit 1
  fi
  echo "Payload hash verified before install: $actual_hash_value (files=$actual_file_count bytes=$actual_byte_count)."
fi

if [[ "$PAYLOAD_SOURCE_DIR" != "$AGENT" ]]; then
  mkdir -p "$ROOT"
  systemctl stop homelab-agent.service >/dev/null 2>&1 || true
  rm -rf "$AGENT"
  mkdir -p "$AGENT"
  cp -a "$PAYLOAD_SOURCE_DIR/." "$AGENT/"
  echo "Homelabv4 agent payload copied from staging directory."
  echo "Verifying payload hash after install to AGENT."
  installed_hash="$(payload_hash_for_directory "$AGENT")"
  installed_hash_value="$(printf '%s\n' "$installed_hash" | sed -n '1p')"
  installed_file_count="$(printf '%s\n' "$installed_hash" | sed -n '2p')"
  installed_byte_count="$(printf '%s\n' "$installed_hash" | sed -n '3p')"
  if [[ "$installed_hash_value" != "$actual_hash_value" ]]; then
    echo "Installed payload hash mismatch after copy."
    echo "Expected source hash: $actual_hash_value"
    echo "Installed hash:     : $installed_hash_value"
    exit 1
  fi
  echo "Installed payload hash verified: $installed_hash_value (files=$installed_file_count bytes=$installed_byte_count)."
fi

if [[ -f "$AGENT/.payload-manifest.json" ]]; then
  echo "Homelabv4 agent payload manifest:"
  cat "$AGENT/.payload-manifest.json"
  echo
fi

if [[ -f "$AGENT/core/bin/homelab" ]]; then
  echo "Installing bundled Homelab v3 core script payload into $CORE"
  find "$CORE" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  cp -a "$AGENT/core/." "$CORE/"
elif [[ "$ALLOW_GITHUB_FALLBACK" == "1" ]] && command -v git >/dev/null 2>&1; then
  if [[ -d "$CORE/.git" ]]; then
    git -C "$CORE" fetch origin "$REPO_REF" || true
    git -C "$CORE" checkout "$REPO_REF" || true
    git -C "$CORE" pull --ff-only origin "$REPO_REF" || true
  else
    git clone -b "$REPO_REF" "$REPO_URL" "$CORE" || true
  fi
else
  if [[ "$ALLOW_GITHUB_FALLBACK" != "1" ]]; then
    echo "No bundled core payload found and GitHub fallback is disabled."
    echo "Set HOMELABV4_ALLOW_GITHUB_FALLBACK=1 or provide AGENT/core/bin/homelab in bootstrap payload."
    exit 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "No bundled core payload found and git is not installed."
    echo "Install git on Proxmox or run bootstrap with fallback disabled for local-only payload."
    exit 1
  fi
  echo "Fallback is enabled but core repository checkout/clone did not complete."
fi

find "$AGENT/tasks" -type f -name '*.sh' -exec chmod +x {} \; 2>/dev/null || true
find "$AGENT/core" "$CORE" -type f -name '*.sh' -exec chmod +x {} \; 2>/dev/null || true
find "$AGENT/core/bin" "$CORE/bin" -type f -exec chmod +x {} \; 2>/dev/null || true

cat > "$SERVICE" <<SERVICE
[Unit]
Description=Homelabv4 localhost agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOMELABV4_ROOT=$ROOT
ExecStart=/usr/bin/python3 $AGENT/homelab-agent.py
Restart=on-failure
RestartSec=5
User=root
WorkingDirectory=$AGENT

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
if systemctl is-active --quiet homelab-agent.service; then
  echo "Restarting Homelabv4 agent service to load updated payload..."
  systemctl restart homelab-agent.service
else
  echo "Starting Homelabv4 agent service..."
  systemctl enable --now homelab-agent.service
fi
systemctl status homelab-agent.service --no-pager || true

echo "Homelabv4 agent installed on 127.0.0.1:48114"
