#!/usr/bin/env bash
# Expose the loopback-only noVNC service to the worker through a private Unix socket.
set -euo pipefail
SSH_TARGET="${PROCESS_AUDIO_HETZNER_SSH_TARGET:?PROCESS_AUDIO_HETZNER_SSH_TARGET is required}"
REMOTE_DIR="${PROCESS_AUDIO_HETZNER_REMOTE_DIR:-/opt/upperroom/process-audio-hetzner}"
ssh "$SSH_TARGET" "bash -s -- '$REMOTE_DIR'" <<'REMOTE_SCRIPT'
set -euo pipefail
remote_dir="$1"
if ! command -v socat >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y socat
fi
install -d -m 0755 "${remote_dir}/state/browser-desktop"
unit_file="/etc/systemd/system/process-audio-browser-desktop-bridge.service"
unit_temp="$(mktemp)"
trap 'rm -f "$unit_temp"' EXIT
cat >"$unit_temp" <<EOF_UNIT
[Unit]
Description=Private Unix socket bridge for admin YouTube desktop
After=process-audio-browser-novnc.service
Wants=process-audio-browser-novnc.service

[Service]
Type=simple
ExecStart=/usr/bin/socat UNIX-LISTEN:${remote_dir}/state/browser-desktop/novnc.sock,fork,unlink-early,mode=0600,user=1000,group=1000 TCP:127.0.0.1:3010
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${remote_dir}/state/browser-desktop

[Install]
WantedBy=multi-user.target
EOF_UNIT
if ! cmp -s "$unit_temp" "$unit_file"; then
  install -m 0644 "$unit_temp" "$unit_file"
  systemctl daemon-reload
  systemctl restart process-audio-browser-desktop-bridge.service
fi
systemctl enable --now process-audio-browser-desktop-bridge.service
REMOTE_SCRIPT
