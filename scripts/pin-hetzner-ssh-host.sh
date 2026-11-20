#!/usr/bin/env bash
set -euo pipefail

# Called on the dedicated GitHub-hosted deployment runner before its private key is installed.
host="${1:?missing deployment hostname}"
[[ "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]] || { echo "Invalid deployment hostname" >&2; exit 1; }
script_dir="$(cd "$(dirname "$0")" && pwd)"
pin="$(cat "$script_dir/../ops/process-audio-hetzner/ssh-host-ed25519.sha256")"
umask 077
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
ssh-keyscan -T 10 -t ed25519 "$host" 2>/dev/null |
  awk '$1 !~ /^#/ && $2 == "ssh-ed25519" && NF == 3 { print $2, $3 }' |
  sort -u > "$temp_dir/key"
[[ "$(wc -l < "$temp_dir/key")" -eq 1 ]] || { echo "Expected one deployment host key" >&2; exit 1; }
fingerprint="$(ssh-keygen -E sha256 -lf "$temp_dir/key" | awk '{print $2}')"
[[ "$fingerprint" == "$pin" && "$pin" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || {
  echo "Deployment host key does not match its reviewed pin" >&2
  exit 1
}

install -d -m 700 "$HOME/.ssh"
printf '%s %s\n' "$host" "$(cat "$temp_dir/key")" > "$HOME/.ssh/hetzner_known_hosts"
cat > "$temp_dir/config" <<CONFIG
Host $host
    BatchMode yes
    StrictHostKeyChecking yes
    HostKeyAlgorithms ssh-ed25519
    UserKnownHostsFile ~/.ssh/hetzner_known_hosts
    GlobalKnownHostsFile /dev/null
    VerifyHostKeyDNS no
    UpdateHostKeys no
Host *
CONFIG
# OpenSSH takes the first value for each option. Preserve unrelated runner settings.
if [[ -f "$HOME/.ssh/config" ]]; then cat "$HOME/.ssh/config" >> "$temp_dir/config"; fi
install -m 600 "$temp_dir/config" "$HOME/.ssh/config"
