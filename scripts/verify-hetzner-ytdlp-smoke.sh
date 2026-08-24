#!/usr/bin/env bash

set -euo pipefail

GUEST_RATE_LIMIT_PATTERN='http error 429'
GUEST_FALLBACK_PATTERN="sign in to confirm (you're|you’re) not a bot|login_required|the page needs to be reloaded"

if [[ "${1:-}" == "--self-test-classifier" ]]; then
  rate_limit_fixture='ERROR: HTTP Error 429: Too Many Requests'
  login_fixture='ERROR: LOGIN_REQUIRED'
  if printf '%s\n' "$rate_limit_fixture" | grep -Eiq "$GUEST_FALLBACK_PATTERN" \
    || ! printf '%s\n' "$rate_limit_fixture" | grep -Eiq "$GUEST_RATE_LIMIT_PATTERN"; then
    echo "Classifier self-test failed: HTTP 429 must fail without authenticated fallback" >&2
    exit 1
  fi
  if ! printf '%s\n' "$login_fixture" | grep -Eiq "$GUEST_FALLBACK_PATTERN"; then
    echo "Classifier self-test failed: LOGIN_REQUIRED must allow authenticated fallback" >&2
    exit 1
  fi
  echo "YouTube smoke classifier self-test passed"
  exit 0
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <staging|production|--self-test-classifier>" >&2
  exit 64
fi

TARGET_ENV="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_TARGET="${PROCESS_AUDIO_HETZNER_SSH_TARGET:-}"
REMOTE_DIR="${PROCESS_AUDIO_HETZNER_REMOTE_DIR:-/opt/upperroom/process-audio-hetzner}"
PUBLIC_SMOKE_URL="${PROCESS_AUDIO_HETZNER_PUBLIC_SMOKE_YOUTUBE_URL:-${PROCESS_AUDIO_HETZNER_SMOKE_YOUTUBE_URL:-}}"
AUTH_SMOKE_URL="${PROCESS_AUDIO_HETZNER_AUTH_SMOKE_YOUTUBE_URL:-}"
SMOKE_SECTION_SECONDS="${PROCESS_AUDIO_HETZNER_SMOKE_SECTION_SECONDS:-8}"
MEDIA_RUNTIME_VERSION_FILE="$ROOT_DIR/ops/process-audio-hetzner/media-runtime-versions.env"

[[ -f "$MEDIA_RUNTIME_VERSION_FILE" ]] || { echo "Missing media runtime version contract: $MEDIA_RUNTIME_VERSION_FILE" >&2; exit 65; }
set -a
# shellcheck disable=SC1090 -- repository-owned version contract
source "$MEDIA_RUNTIME_VERSION_FILE"
set +a
EXPECTED_YTDLP_VERSION="${PROCESS_AUDIO_YTDLP_VERSION:?PROCESS_AUDIO_YTDLP_VERSION is required}"
EXPECTED_BGUTIL_VERSION="${PROCESS_AUDIO_BGUTIL_VERSION:?PROCESS_AUDIO_BGUTIL_VERSION is required}"
EXPECTED_PROVIDER_IMAGE="${PROCESS_AUDIO_BGUTIL_IMAGE:?PROCESS_AUDIO_BGUTIL_IMAGE is required}"

case "$TARGET_ENV" in
  staging)
    CONTAINER_NAME="process-audio-hetzner-process-audio-staging-1"
    PROVIDER_SERVICE="ytdlp-pot-provider-staging"
    ;;
  production)
    CONTAINER_NAME="process-audio-hetzner-process-audio-production-1"
    PROVIDER_SERVICE="ytdlp-pot-provider-production"
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

if [[ -z "$PUBLIC_SMOKE_URL" ]]; then
  echo "PROCESS_AUDIO_HETZNER_PUBLIC_SMOKE_YOUTUBE_URL is required and must identify an owned, public canary" >&2
  exit 66
fi

if [[ -z "$AUTH_SMOKE_URL" ]]; then
  echo "PROCESS_AUDIO_HETZNER_AUTH_SMOKE_YOUTUBE_URL is required and must identify an owned, account-visible canary" >&2
  exit 67
fi

if ! [[ "$SMOKE_SECTION_SECONDS" =~ ^[0-9]+$ ]] || (( SMOKE_SECTION_SECONDS < 2 || SMOKE_SECTION_SECONDS > 30 )); then
  echo "PROCESS_AUDIO_HETZNER_SMOKE_SECTION_SECONDS must be an integer from 2 through 30" >&2
  exit 68
fi

for smoke_url in "$PUBLIC_SMOKE_URL" "$AUTH_SMOKE_URL"; do
  if ! [[ "$smoke_url" =~ ^https://(www\.)?(youtube\.com|youtu\.be)/ ]]; then
    echo "Smoke URLs must be HTTPS youtube.com or youtu.be URLs" >&2
    exit 69
  fi
done

# A healthy provider process and an active browser fallback stack are deployment
# prerequisites. The media checks below establish whether those dependencies are
# useful, rather than merely present.
ssh "$SSH_TARGET" "bash -s -- '${REMOTE_DIR}' '${PROVIDER_SERVICE}' '${EXPECTED_PROVIDER_IMAGE}' '${TARGET_ENV}'" <<'HOST_EOF'
set -euo pipefail

remote_dir="$1"
provider_service="$2"
expected_provider_image="$3"
target_env="$4"
profile_dir="${remote_dir}/state/shared-browser-profile/.config/google-chrome"
refresh_control_dir="${remote_dir}/state/browser-refresh-control"
worker_env_file="${remote_dir}/env/process-audio-${target_env}.env"
required_units=(
  process-audio-browser-xvfb.service
  process-audio-browser-openbox.service
  process-audio-browser-x11vnc.service
  process-audio-browser-novnc.service
  process-audio-browser-chrome.service
  process-audio-browser-refresh.service
  process-audio-browser-pot.service
)

cd "$remote_dir"
provider_container_id="$(docker compose ps -q "$provider_service")"
[[ -n "$provider_container_id" ]] || { echo "Provider service ${provider_service} has no container" >&2; exit 1; }
provider_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$provider_container_id")"
[[ "$provider_health" == "healthy" ]] || { echo "Provider service ${provider_service} is ${provider_health}" >&2; exit 1; }
provider_image="$(docker inspect --format '{{.Config.Image}}' "$provider_container_id")"
[[ "$provider_image" == "$expected_provider_image" ]] || {
  echo "Provider image mismatch: expected ${expected_provider_image}, got ${provider_image}" >&2
  exit 1
}

systemctl is-active --quiet process-audio-browser-auth.target
for unit in "${required_units[@]}"; do
  systemctl is-active --quiet "$unit"
done

[[ -f "${profile_dir}/Default/Cookies" ]] || {
  echo "Shared Chrome profile is missing ${profile_dir}/Default/Cookies" >&2
  exit 1
}
[[ -d "$refresh_control_dir" && -w "$refresh_control_dir" ]] || {
  echo "Browser control dir is missing or not writable: ${refresh_control_dir}" >&2
  exit 1
}
[[ -f "$worker_env_file" && "$(stat -c %a "$worker_env_file")" == 600 ]] || {
  echo "Worker environment file must exist with mode 0600: ${worker_env_file}" >&2
  exit 1
}
[[ "$(stat -c %u "$worker_env_file")" == "$(id -u)" ]] || {
  echo "Worker environment file is not owned by the deployment account: ${worker_env_file}" >&2
  exit 1
}
HOST_EOF

public_smoke_url_b64="$(printf '%s' "$PUBLIC_SMOKE_URL" | base64 | tr -d '\n')"
auth_smoke_url_b64="$(printf '%s' "$AUTH_SMOKE_URL" | base64 | tr -d '\n')"
guest_rate_limit_pattern_b64="$(printf '%s' "$GUEST_RATE_LIMIT_PATTERN" | base64 | tr -d '\n')"
guest_fallback_pattern_b64="$(printf '%s' "$GUEST_FALLBACK_PATTERN" | base64 | tr -d '\n')"

ssh "$SSH_TARGET" \
  "docker exec -i \
    -e PUBLIC_SMOKE_URL_B64='${public_smoke_url_b64}' \
    -e AUTH_SMOKE_URL_B64='${auth_smoke_url_b64}' \
    -e SMOKE_SECTION_SECONDS='${SMOKE_SECTION_SECONDS}' \
    -e EXPECTED_YTDLP_VERSION='${EXPECTED_YTDLP_VERSION}' \
    -e EXPECTED_BGUTIL_VERSION='${EXPECTED_BGUTIL_VERSION}' \
    -e GUEST_RATE_LIMIT_PATTERN_B64='${guest_rate_limit_pattern_b64}' \
    -e GUEST_FALLBACK_PATTERN_B64='${guest_fallback_pattern_b64}' \
    '${CONTAINER_NAME}' /bin/bash -s" <<'CONTAINER_EOF'
set -euo pipefail

public_smoke_url="$(printf '%s' "$PUBLIC_SMOKE_URL_B64" | base64 -d)"
auth_smoke_url="$(printf '%s' "$AUTH_SMOKE_URL_B64" | base64 -d)"
guest_rate_limit_pattern="$(printf '%s' "$GUEST_RATE_LIMIT_PATTERN_B64" | base64 -d)"
guest_fallback_pattern="$(printf '%s' "$GUEST_FALLBACK_PATTERN_B64" | base64 -d)"
provider_base_url="${YTDLP_POT_PROVIDER_BASE_URL:?YTDLP_POT_PROVIDER_BASE_URL is required}"
browser_profile_dir="${PROCESS_AUDIO_BROWSER_PROFILE_DIR:?PROCESS_AUDIO_BROWSER_PROFILE_DIR is required for authenticated fallback smoke}"
browser_name="${PROCESS_AUDIO_BROWSER_PROFILE_BROWSER:-chrome}"
section_spec="*0-${SMOKE_SECTION_SECONDS}"
max_duration_seconds=$((SMOKE_SECTION_SECONDS + 8))

actual_ytdlp_version="$(yt-dlp --version)"
[[ "$actual_ytdlp_version" == "$EXPECTED_YTDLP_VERSION" ]] || {
  echo "yt-dlp version mismatch: expected ${EXPECTED_YTDLP_VERSION}, got ${actual_ytdlp_version}" >&2
  exit 1
}

actual_bgutil_version="$(python3 -c "from importlib.metadata import version; print(version('bgutil-ytdlp-pot-provider'))")"
[[ "$actual_bgutil_version" == "$EXPECTED_BGUTIL_VERSION" ]] || {
  echo "bgutil plugin version mismatch: expected ${EXPECTED_BGUTIL_VERSION}, got ${actual_bgutil_version}" >&2
  exit 1
}

credential_path=/workspace/logs/firebase-service-account.json
[[ -f "$credential_path" && "$(stat -c %a "$credential_path")" == 600 ]] || {
  echo "Generated Firebase credential must exist with mode 0600" >&2
  exit 1
}
[[ "$(stat -c %u "$credential_path")" == "$(id -u)" ]] || {
  echo "Generated Firebase credential is not owned by the worker user" >&2
  exit 1
}

provider_ping="$(curl -fsS "${provider_base_url}/ping")"
python3 - "$provider_ping" "$EXPECTED_BGUTIL_VERSION" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
if payload.get('version') != sys.argv[2]:
    raise SystemExit(f"provider /ping version mismatch: expected {sys.argv[2]}, got {payload.get('version')}")
PY

report_canary() {
  local scope="$1"
  local succeeded="$2"
  local bytes_downloaded="$3"
  local failure_class="$4"
  local checked_at
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 - "$scope" "$checked_at" "$succeeded" "$bytes_downloaded" "$failure_class" <<'PY' \
    | curl -fsS -X POST \
        -H 'content-type: application/json' \
        --data-binary @- \
        http://127.0.0.1:8080/internal/youtube-canary >/dev/null
import json
import sys

scope, checked_at, succeeded, bytes_downloaded, failure_class = sys.argv[1:]
json.dump({
    'scope': scope,
    'checkedAt': checked_at,
    'succeeded': succeeded == 'true',
    'bytesDownloaded': int(bytes_downloaded),
    'failureClass': failure_class or None,
}, sys.stdout, separators=(',', ':'))
PY
}

redact_log() {
  sed -E 's/(po_token=[^+[:space:];]+\+)[^[:space:];]+/\1[redacted]/g' "$1" >&2
}

verify_media_artifact() {
  local mode="$1"
  local media_file="$2"
  local probe_json="$3"
  verified_media_bytes=0
  [[ -s "$media_file" ]] || { echo "${mode} smoke produced no media bytes" >&2; return 1; }
  ffprobe -v error -show_entries format=duration,size -of json "$media_file" > "$probe_json"
  python3 - "$probe_json" "$mode" "$max_duration_seconds" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as handle:
    result = json.load(handle)
details = result.get('format') or {}
duration = float(details.get('duration') or 0)
size = int(details.get('size') or 0)
maximum = float(sys.argv[3])
if not 0 < duration <= maximum:
    raise SystemExit(f'{sys.argv[2]} smoke duration out of bounds: {duration}s (max {maximum}s)')
if size < 1024:
    raise SystemExit(f'{sys.argv[2]} smoke artifact is unexpectedly small: {size} bytes')
print(f'{sys.argv[2]} media canary passed: duration={duration:.3f}s size={size} bytes')
PY
  verified_media_bytes="$(stat -c %s "$media_file")"
}

run_media_canary() {
  local mode="$1"
  local smoke_url="$2"
  local temp_dir stderr_log stdout_log status media_file scope failure_class
  if [[ "$mode" == "public_provider" ]]; then
    scope=guest
  else
    scope=authenticated
  fi
  temp_dir="$(mktemp -d "/tmp/process-audio-${mode}-smoke.XXXXXX")"
  stderr_log="${temp_dir}/yt-dlp.stderr.log"
  stdout_log="${temp_dir}/yt-dlp.stdout.log"

  echo "Running bounded YouTube media canary: attemptMode=${mode} sectionSeconds=${SMOKE_SECTION_SECONDS}"
  set +e
  if [[ "$mode" == "public_provider" ]]; then
    timeout 180 yt-dlp -v \
      --no-playlist \
      --no-cache-dir \
      --no-part \
      --no-continue \
      --no-js-runtimes --js-runtimes deno \
      --download-sections "$section_spec" \
      --force-keyframes-at-cuts \
      -f 'ba[ext=m4a]/ba[ext=webm]/ba' \
      -o "${temp_dir}/canary.%(ext)s" \
      --extractor-args 'youtube:player_client=default,mweb,-web_creator' \
      --extractor-args "youtubepot-bgutilhttp:base_url=${provider_base_url}" \
      "$smoke_url" >"$stdout_log" 2>"$stderr_log"
    status=$?
  else
    timeout 180 yt-dlp -v \
      --no-playlist \
      --no-cache-dir \
      --no-part \
      --no-continue \
      --no-js-runtimes --js-runtimes deno \
      --cookies-from-browser "${browser_name}:${browser_profile_dir}" \
      --download-sections "$section_spec" \
      --force-keyframes-at-cuts \
      -f 'ba[ext=m4a]/ba[ext=webm]/ba' \
      -o "${temp_dir}/canary.%(ext)s" \
      --extractor-args 'youtube:player_client=default,mweb,-web_creator' \
      --extractor-args "youtubepot-bgutilhttp:base_url=${provider_base_url}" \
      "$smoke_url" >"$stdout_log" 2>"$stderr_log"
    status=$?
  fi
  set -e

  grep -F "PO Token Providers: bgutil:http-${EXPECTED_BGUTIL_VERSION}" "$stderr_log" >/dev/null || {
    echo "${mode} smoke did not discover bgutil:http-${EXPECTED_BGUTIL_VERSION}" >&2
    redact_log "$stderr_log"
    report_canary "$scope" false 0 provider_unhealthy || true
    rm -rf "$temp_dir"
    return 1
  }

  if (( status != 0 )); then
    if [[ "$mode" == "public_provider" ]] && grep -Eiq "$guest_rate_limit_pattern" "$stderr_log"; then
      echo "public_provider was rate limited; authenticated fallback is not eligible" >&2
      redact_log "$stderr_log"
      report_canary guest false 0 rate_limited || true
      rm -rf "$temp_dir"
      return 1
    fi
    if [[ "$mode" == "public_provider" ]] && grep -Eiq "$guest_fallback_pattern" "$stderr_log"; then
      if grep -Eiq "login_required" "$stderr_log"; then
        failure_class=account_required_content
      else
        failure_class=public_path_bot_blocked
      fi
      echo "public_provider encountered a recognized guest restriction; authenticated fallback is eligible"
      redact_log "$stderr_log"
      report_canary guest false 0 "$failure_class" || {
        rm -rf "$temp_dir"
        return 1
      }
      rm -rf "$temp_dir"
      return 10
    fi
    echo "${mode} yt-dlp media canary failed with exit code ${status}" >&2
    redact_log "$stderr_log"
    if [[ "$scope" == guest ]]; then failure_class=unclassified_error; else failure_class=authenticated_media_failed; fi
    report_canary "$scope" false 0 "$failure_class" || true
    rm -rf "$temp_dir"
    return 1
  fi

  if [[ "$mode" == "public_provider" ]]; then
    if grep -F -- '--cookies-from-browser' "$stderr_log" >/dev/null; then
      echo "Public smoke unexpectedly used browser cookies" >&2
      report_canary guest false 0 mode_contract_violation || true
      rm -rf "$temp_dir"
      return 1
    fi
  elif ! grep -F -- '--cookies-from-browser' "$stderr_log" >/dev/null; then
    echo "Authenticated smoke did not use the configured browser profile" >&2
    report_canary authenticated false 0 mode_contract_violation || true
    rm -rf "$temp_dir"
    return 1
  fi

  media_file="$(find "$temp_dir" -maxdepth 1 -type f ! -name '*.log' ! -name 'ffprobe.json' -print -quit)"
  [[ -n "$media_file" ]] || {
    echo "${mode} smoke did not create a media artifact" >&2
    report_canary "$scope" false 0 invalid_media_artifact || true
    rm -rf "$temp_dir"
    return 1
  }
  if ! verify_media_artifact "$mode" "$media_file" "${temp_dir}/ffprobe.json"; then
    report_canary "$scope" false 0 invalid_media_artifact || true
    rm -rf "$temp_dir"
    return 1
  fi
  report_canary "$scope" true "$verified_media_bytes" "" || {
    rm -rf "$temp_dir"
    return 1
  }
  rm -rf "$temp_dir"
}

if run_media_canary public_provider "$public_smoke_url"; then
  echo "Public canary completed through the cookie-free guest path"
else
  public_status=$?
  if (( public_status != 10 )); then
    exit "$public_status"
  fi
  run_media_canary public_cookie_fallback "$public_smoke_url"
  echo "Public canary completed through classified authenticated fallback"
fi
run_media_canary cookie_provider "$auth_smoke_url"
curl -fsS http://127.0.0.1:8080/readyz >/dev/null
echo "Hetzner yt-dlp public and authenticated media smoke tests passed"
CONTAINER_EOF
