#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <staging|production>" >&2
  exit 64
fi

TARGET_ENV="$1"
SSH_TARGET="${PROCESS_AUDIO_HETZNER_SSH_TARGET:-}"
REMOTE_DIR="${PROCESS_AUDIO_HETZNER_REMOTE_DIR:-/opt/upperroom/process-audio-hetzner}"
SMOKE_URL="${PROCESS_AUDIO_HETZNER_SMOKE_YOUTUBE_URL:-https://youtu.be/dKaZ89SkVYY}"

case "$TARGET_ENV" in
  staging)
    CONTAINER_NAME="process-audio-hetzner-process-audio-staging-1"
    ;;
  production)
    CONTAINER_NAME="process-audio-hetzner-process-audio-production-1"
    ;;
  *)
    echo "Unsupported environment: $TARGET_ENV" >&2
    exit 64
    ;;
esac

if [[ -z "$SSH_TARGET" ]]; then
  echo "PROCESS_AUDIO_HETZNER_SSH_TARGET is required" >&2
  exit 65
fi

json_output="$(
  ssh "$SSH_TARGET" "cd ${REMOTE_DIR} && docker exec ${CONTAINER_NAME} yt-dlp -J \
    --cookies-from-browser chrome:/workspace/shared-browser-profile/.config/google-chrome \
    --no-playlist \
    --skip-download \
    --no-js-runtimes --js-runtimes deno \
    --sleep-requests 2 \
    --sleep-interval 1 \
    --max-sleep-interval 3 \
    --extractor-args 'youtube:player_client=default,mweb,-web_creator' \
    --extractor-args 'youtubepot-bgutilhttp:base_url=http://ytdlp-pot-provider:4416' \
    '${SMOKE_URL}'"
)"

JSON_OUTPUT="$json_output" python3 - <<'PY'
import json, sys
import os

data = json.loads(os.environ["JSON_OUTPUT"])
formats = data.get("formats") or []
has_audio = any(
    isinstance(fmt, dict)
    and fmt.get("vcodec") == "none"
    and fmt.get("url")
    for fmt in formats
)

if not has_audio:
    raise SystemExit("No playable audio format returned by yt-dlp smoke test")

print("Hetzner yt-dlp smoke test passed")
PY
