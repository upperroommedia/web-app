#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: $0 <health_url> [max_attempts] [sleep_seconds]" >&2
  exit 64
fi

health_url="$1"
max_attempts="${2:-20}"
sleep_seconds="${3:-3}"

attempt=1
while (( attempt <= max_attempts )); do
  if response="$(curl -fsS "$health_url" 2>/dev/null)"; then
    printf '%s\n' "$response"
    exit 0
  fi

  if (( attempt == max_attempts )); then
    echo "Health check failed for ${health_url} after ${max_attempts} attempts" >&2
    curl -iS "$health_url" || true
    exit 1
  fi

  echo "Health check attempt ${attempt}/${max_attempts} failed for ${health_url}; retrying in ${sleep_seconds}s..." >&2
  sleep "$sleep_seconds"
  ((attempt += 1))
done
