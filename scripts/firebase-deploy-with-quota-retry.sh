#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <firebase deploy args...>" >&2
  exit 64
fi

MAX_ATTEMPTS="${FIREBASE_DEPLOY_MAX_ATTEMPTS:-3}"
INITIAL_SLEEP_SECONDS="${FIREBASE_DEPLOY_QUOTA_SLEEP_SECONDS:-75}"
QUOTA_PATTERN="Quota exceeded for quota metric 'Per project mutation requests'"

attempt=1
while true; do
  echo "Running Firebase deploy attempt ${attempt}/${MAX_ATTEMPTS}: firebase $*" >&2
  set +e
  output="$(pnpm exec firebase "$@" 2>&1)"
  status=$?
  set -e

  printf '%s\n' "$output"

  if [[ $status -eq 0 ]]; then
    exit 0
  fi

  if [[ $attempt -ge $MAX_ATTEMPTS ]] || ! grep -Fq "$QUOTA_PATTERN" <<<"$output"; then
    exit "$status"
  fi

  sleep_seconds=$(( INITIAL_SLEEP_SECONDS * attempt ))
  echo "Cloud Functions mutation quota hit. Sleeping ${sleep_seconds}s before retry." >&2
  sleep "$sleep_seconds"
  attempt=$(( attempt + 1 ))
done
