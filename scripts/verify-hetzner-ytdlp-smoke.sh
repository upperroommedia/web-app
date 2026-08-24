#!/usr/bin/env bash

set -euo pipefail

GUEST_AUTH_RESOLVABLE_FAILURE_CLASSES='public_path_bot_blocked account_required_content'

if [[ "${1:-}" == "--self-test-classifier" ]]; then
  smoke_source="$(<"${BASH_SOURCE[0]}")"
  legacy_cookie_flag='--cookies-from-'"browser"
  legacy_runner='run_media_'"canary"
  [[ " $GUEST_AUTH_RESOLVABLE_FAILURE_CLASSES " == *' public_path_bot_blocked '* ]]
  [[ " $GUEST_AUTH_RESOLVABLE_FAILURE_CLASSES " == *' account_required_content '* ]]
  [[ " $GUEST_AUTH_RESOLVABLE_FAILURE_CLASSES " != *' rate_limited '* ]]
  [[ "$smoke_source" == *'/internal/youtube-canary/run'* ]]
  [[ "$smoke_source" != *"$legacy_cookie_flag"* ]]
  [[ "$smoke_source" != *"$legacy_runner"* ]]
  echo "YouTube application-canary smoke contract self-test passed"
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
guest_auth_resolvable_classes_b64="$(printf '%s' "$GUEST_AUTH_RESOLVABLE_FAILURE_CLASSES" | base64 | tr -d '\n')"

ssh "$SSH_TARGET" \
  "docker exec -i \
    -e PUBLIC_SMOKE_URL_B64='${public_smoke_url_b64}' \
    -e AUTH_SMOKE_URL_B64='${auth_smoke_url_b64}' \
    -e EXPECTED_YTDLP_VERSION='${EXPECTED_YTDLP_VERSION}' \
    -e EXPECTED_BGUTIL_VERSION='${EXPECTED_BGUTIL_VERSION}' \
    -e GUEST_AUTH_RESOLVABLE_CLASSES_B64='${guest_auth_resolvable_classes_b64}' \
    '${CONTAINER_NAME}' /bin/bash -s" <<'CONTAINER_EOF'
set -euo pipefail

public_smoke_url="$(printf '%s' "$PUBLIC_SMOKE_URL_B64" | base64 -d)"
auth_smoke_url="$(printf '%s' "$AUTH_SMOKE_URL_B64" | base64 -d)"
guest_auth_resolvable_classes="$(printf '%s' "$GUEST_AUTH_RESOLVABLE_CLASSES_B64" | base64 -d)"
provider_base_url="${YTDLP_POT_PROVIDER_BASE_URL:?YTDLP_POT_PROVIDER_BASE_URL is required}"
[[ "${PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL:-}" == "$public_smoke_url" ]] || {
  echo "Worker guest canary URL does not match the deployment input" >&2
  exit 1
}
[[ "${PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL:-}" == "$auth_smoke_url" ]] || {
  echo "Worker authenticated canary URL does not match the deployment input" >&2
  exit 1
}

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

provider_ping="$(curl -fsS --connect-timeout 5 --max-time 10 "${provider_base_url}/ping")"
python3 - "$provider_ping" "$EXPECTED_BGUTIL_VERSION" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
if payload.get('version') != sys.argv[2]:
    raise SystemExit(f"provider /ping version mismatch: expected {sys.argv[2]}, got {payload.get('version')}")
PY

trigger_application_canary() {
  local scope="$1"
  local response
  response="$(curl -fsS --connect-timeout 5 --max-time 360 -X POST \
    -H 'content-type: application/json' \
    --data-binary "{\"scope\":\"${scope}\"}" \
    http://127.0.0.1:8080/internal/youtube-canary/run)"
  python3 - "$response" "$scope" "$guest_auth_resolvable_classes" <<'PY'
import datetime
import json
import sys

payload = json.loads(sys.argv[1])
scope = sys.argv[2]
allowed_guest_failures = set(sys.argv[3].split())
if set(payload) != {'report', 'committed'} or payload.get('committed') is not True:
    raise SystemExit(f'{scope} application canary was not transactionally committed')
report = payload.get('report')
if not isinstance(report, dict) or set(report) != {
    'scope', 'checkedAt', 'succeeded', 'bytesDownloaded', 'failureClass'
}:
    raise SystemExit(f'{scope} application canary returned an invalid report')
if report['scope'] != scope or not isinstance(report['succeeded'], bool):
    raise SystemExit(f'{scope} application canary returned an invalid scope/status')
if not isinstance(report['bytesDownloaded'], int) or isinstance(report['bytesDownloaded'], bool):
    raise SystemExit(f'{scope} application canary returned invalid byte evidence')
datetime.datetime.fromisoformat(report['checkedAt'].replace('Z', '+00:00'))
if report['succeeded']:
    if report['bytesDownloaded'] <= 0 or report['failureClass'] is not None:
        raise SystemExit(f'{scope} application canary succeeded without valid media-byte evidence')
elif scope == 'guest':
    if report['bytesDownloaded'] != 0 or report['failureClass'] not in allowed_guest_failures:
        raise SystemExit(
            f"guest application canary failed with non-resolvable class {report['failureClass']!r}"
        )
else:
    raise SystemExit(
        f"authenticated application recovery canary failed: {report['failureClass']!r}"
    )
print(json.dumps(payload, separators=(',', ':')))
PY
}

guest_trigger="$(trigger_application_canary guest)"
echo "Application guest canary produced accepted media-byte evidence or a classified auth-resolvable restriction"
authenticated_trigger="$(trigger_application_canary authenticated)"
echo "Application authenticated canary completed the production recovery policy with media bytes"

readiness="$(curl -fsS --connect-timeout 5 --max-time 15 http://127.0.0.1:8080/readyz)"
python3 - "$guest_trigger" "$authenticated_trigger" "$readiness" "$EXPECTED_BGUTIL_VERSION" "$guest_auth_resolvable_classes" <<'PY'
import datetime
import json
import sys

guest_trigger = json.loads(sys.argv[1])['report']
auth_trigger = json.loads(sys.argv[2])['report']
readiness = json.loads(sys.argv[3])
expected_provider_version = sys.argv[4]
allowed_guest_failures = set(sys.argv[5].split())

def parsed_time(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))

def core(report):
    return {key: report.get(key) for key in (
        'scope', 'checkedAt', 'succeeded', 'bytesDownloaded', 'failureClass'
    )}

def acceptable(scope, report):
    if report.get('succeeded') is True:
        return report.get('bytesDownloaded', 0) > 0 and report.get('failureClass') is None
    return (
        scope == 'guest'
        and report.get('bytesDownloaded') == 0
        and report.get('failureClass') in allowed_guest_failures
    )

def assert_monotonic(scope, triggered, persisted):
    if persisted.get('scope') not in (None, scope):
        raise SystemExit(f'{scope} readiness evidence has the wrong scope')
    triggered_at = parsed_time(triggered['checkedAt'])
    persisted_at = parsed_time(persisted['checkedAt'])
    if persisted_at < triggered_at:
        raise SystemExit(f'{scope} readiness evidence predates the triggered application canary')
    if persisted_at == triggered_at:
        persisted_core = core(persisted)
        persisted_core['scope'] = scope
        if persisted_core != triggered:
            raise SystemExit(f'{scope} readiness evidence conflicts with its triggered report')
    elif not acceptable(scope, persisted):
        raise SystemExit(f'newer {scope} readiness evidence does not satisfy deployment acceptance')

provider = readiness.get('provider') or {}
if not (
    provider.get('configured') is True
    and provider.get('discovered') is True
    and provider.get('reachable') is True
    and provider.get('version') == expected_provider_version
):
    raise SystemExit(f'provider readiness contract failed: {provider!r}')
if (readiness.get('serviceReadiness') or {}).get('ready') is not True:
    raise SystemExit(f"service readiness failed: {(readiness.get('serviceReadiness') or {}).get('reasonCodes')!r}")
capabilities = readiness.get('capabilities') or {}
assert_monotonic('guest', guest_trigger, (capabilities.get('guest') or {}).get('mediaByteCanary') or {})
assert_monotonic(
    'authenticated',
    auth_trigger,
    (capabilities.get('authenticated') or {}).get('mediaByteCanary') or {},
)
print('Application canary reports are committed, monotonic, byte-valid, and readiness-gated')
PY
echo "Hetzner application guest and authenticated recovery canaries passed"
CONTAINER_EOF
