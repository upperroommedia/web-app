#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <staging|production|all>" >&2
  exit 64
fi

TARGET_ENV="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_TARGET="${PROCESS_AUDIO_HETZNER_SSH_TARGET:-}"
REMOTE_DIR="${PROCESS_AUDIO_HETZNER_REMOTE_DIR:-/opt/upperroom/process-audio-hetzner}"
MEDIA_RUNTIME_VERSION_FILE="$ROOT_DIR/ops/process-audio-hetzner/media-runtime-versions.env"

if [[ ! -f "$MEDIA_RUNTIME_VERSION_FILE" ]]; then
  echo "Missing media runtime version contract: $MEDIA_RUNTIME_VERSION_FILE" >&2
  exit 65
fi

set -a
# shellcheck disable=SC1090 -- repository-owned, validated version contract
source "$MEDIA_RUNTIME_VERSION_FILE"
set +a

for version_name in \
  PROCESS_AUDIO_YTDLP_VERSION \
  PROCESS_AUDIO_FFMPEG_VERSION \
  PROCESS_AUDIO_DENO_VERSION \
  PROCESS_AUDIO_BGUTIL_VERSION; do
  version_value="${!version_name:-}"
  [[ "$version_value" =~ ^[0-9]+([.][0-9]+){1,2}$ ]] || {
    echo "Invalid ${version_name} in $MEDIA_RUNTIME_VERSION_FILE: ${version_value:-missing}" >&2
    exit 65
  }
done
[[ "${PROCESS_AUDIO_BGUTIL_IMAGE:-}" =~ ^docker\.io/brainicism/bgutil-ytdlp-pot-provider:${PROCESS_AUDIO_BGUTIL_VERSION}@sha256:[0-9a-f]{64}$ ]] || {
  echo "Invalid PROCESS_AUDIO_BGUTIL_IMAGE in $MEDIA_RUNTIME_VERSION_FILE" >&2
  exit 65
}

PROCESS_AUDIO_DOCKERFILE="$ROOT_DIR/apps/process-audio/Dockerfile"
for expected_arg in \
  "ARG YT_DLP_VERSION=${PROCESS_AUDIO_YTDLP_VERSION}" \
  "ARG FFMPEG_VERSION=${PROCESS_AUDIO_FFMPEG_VERSION}" \
  "ARG BGUTIL_YTDLP_POT_PROVIDER_VERSION=${PROCESS_AUDIO_BGUTIL_VERSION}" \
  "ARG DENO_VERSION=${PROCESS_AUDIO_DENO_VERSION}"; do
  grep -Fqx "$expected_arg" "$PROCESS_AUDIO_DOCKERFILE" || {
    echo "Media runtime contract drift: $PROCESS_AUDIO_DOCKERFILE is missing '$expected_arg'" >&2
    exit 65
  }
done

case "$TARGET_ENV" in
  staging|production|all)
    ;;
  *)
    echo "Unsupported environment: $TARGET_ENV" >&2
    exit 64
    ;;
esac

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 65
  fi
}

require_command gcloud
require_command rsync
require_command ssh
require_command python3
require_command git

if [[ -z "$SSH_TARGET" ]]; then
  echo "PROCESS_AUDIO_HETZNER_SSH_TARGET is required" >&2
  exit 66
fi

ensure_browser_auth_stack() {
  ssh "$SSH_TARGET" "bash -s -- '${REMOTE_DIR}'" <<'EOF'
set -euo pipefail

remote_dir="$1"
profile_dir="${remote_dir}/state/shared-browser-profile/.config/google-chrome"
required_units=(
  process-audio-browser-xvfb.service
  process-audio-browser-openbox.service
  process-audio-browser-x11vnc.service
  process-audio-browser-novnc.service
  process-audio-browser-chrome.service
  process-audio-browser-refresh.service
  process-audio-browser-pot.service
)

systemctl start process-audio-browser-auth.target
systemctl is-active --quiet process-audio-browser-auth.target

for unit in "${required_units[@]}"; do
  systemctl is-active --quiet "$unit"
done

if [[ ! -f "${profile_dir}/Default/Cookies" ]]; then
  echo "Shared Chrome profile is missing ${profile_dir}/Default/Cookies" >&2
  exit 1
fi

printf 'Browser auth stack active. Cookie DB mtime=%s\n' "$(stat -c %y "${profile_dir}/Default/Cookies")"
EOF
}

staging_hostname="${PROCESS_AUDIO_HETZNER_STAGING_HOSTNAME:-}"
production_hostname="${PROCESS_AUDIO_HETZNER_PRODUCTION_HOSTNAME:-}"
public_canary_url="${PROCESS_AUDIO_HETZNER_PUBLIC_SMOKE_YOUTUBE_URL:-}"
auth_canary_url="${PROCESS_AUDIO_HETZNER_AUTH_SMOKE_YOUTUBE_URL:-}"

if [[ -z "$staging_hostname" || -z "$production_hostname" ]]; then
  echo "Both PROCESS_AUDIO_HETZNER_STAGING_HOSTNAME and PROCESS_AUDIO_HETZNER_PRODUCTION_HOSTNAME are required" >&2
  exit 67
fi
validate_canary_url() {
  local variable_name="$1"
  local canary_url="$2"
  local canary_scope="$3"
  if [[ -z "$canary_url" ]]; then
    echo "${variable_name} is required for ${canary_scope} runtime canaries" >&2
    exit 68
  fi
  if ! [[ "$canary_url" =~ ^https://(www\.)?(youtube\.com|youtu\.be)/[^[:space:]]+$ ]]; then
    echo "${variable_name} must be an HTTPS youtube.com or youtu.be URL" >&2
    exit 69
  fi
}
validate_canary_url PROCESS_AUDIO_HETZNER_PUBLIC_SMOKE_YOUTUBE_URL "$public_canary_url" guest
validate_canary_url PROCESS_AUDIO_HETZNER_AUTH_SMOKE_YOUTUBE_URL "$auth_canary_url" authenticated

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
RELEASE_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"

mkdir -p "$WORK_DIR/env" "$WORK_DIR/state/caddy/data" "$WORK_DIR/state/caddy/config"
cp "$ROOT_DIR/ops/process-audio-hetzner/compose.yaml" "$WORK_DIR/compose.yaml"
cp "$ROOT_DIR/ops/process-audio-hetzner/Caddyfile" "$WORK_DIR/Caddyfile"
cp "$ROOT_DIR/ops/process-audio-hetzner/README.md" "$WORK_DIR/README.md"
cp "$MEDIA_RUNTIME_VERSION_FILE" "$WORK_DIR/media-runtime-versions.env"

"$ROOT_DIR/scripts/prepare-process-audio-hetzner-context.sh" "$WORK_DIR/context"

CANDIDATE_CONTEXT_SHA="$(python3 - "$WORK_DIR/context" "$MEDIA_RUNTIME_VERSION_FILE" <<'PY'
import hashlib
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
version_contract = os.path.realpath(sys.argv[2])
digest = hashlib.sha256()
ignored_names = {
    ".git",
    ".github",
    ".next",
    ".turbo",
    ".cache",
    "node_modules",
    "dist",
    "coverage",
    ".DS_Store",
}
def visit(directory):
    for entry in sorted(os.scandir(directory), key=lambda candidate: candidate.name):
        if entry.name in ignored_names or entry.name.endswith(".log"):
            continue
        path = entry.path
        relative_path = os.path.relpath(path, root).replace(os.sep, "/")
        metadata = os.lstat(path)
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(stat.S_IMODE(metadata.st_mode)).encode("ascii"))
        digest.update(b"\0")
        if stat.S_ISLNK(metadata.st_mode):
            digest.update(b"symlink\0")
            digest.update(os.readlink(path).encode("utf-8"))
        elif stat.S_ISDIR(metadata.st_mode):
            digest.update(b"directory\0")
            visit(path)
        else:
            digest.update(b"file\0")
            with open(path, "rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
        digest.update(b"\0")
visit(root)
digest.update(b"__build_args__/media-runtime-versions.env\0")
with open(version_contract, "rb") as source:
    digest.update(source.read())
print(digest.hexdigest())
PY
)"
CANDIDATE_ID="$CANDIDATE_CONTEXT_SHA"
DEPLOYMENT_ID="${RELEASE_SHA:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$$"

write_env_file() {
  local env_name="$1"
  local project_id firebase_project_id bucket database_url env_file_name runtime_alert_recipients service_account_json_b64 sentry_dsn

  if [[ "$env_name" == "staging" ]]; then
    project_id="urm-app-staging"
    firebase_project_id="urm-app-staging"
    bucket="urm-app-staging.firebasestorage.app"
    database_url="https://urm-app-staging-default-rtdb.firebaseio.com/"
    env_file_name="process-audio-staging.env"
  else
    project_id="urm-app"
    firebase_project_id="urm-app"
    bucket="urm-app.appspot.com"
    database_url="https://urm-app-default-rtdb.firebaseio.com/"
    env_file_name="process-audio-production.env"
  fi

  runtime_alert_recipients="$(gcloud secrets versions access latest --secret=RUNTIME_ALERT_RECIPIENTS --project "$project_id")"
  sentry_dsn="$(gcloud secrets versions access latest --secret=PROCESS_AUDIO_SENTRY_DSN --project "$project_id")"
  service_account_json_b64="$(
    gcloud secrets versions access latest --secret=PROCESS_AUDIO_FIREBASE_SERVICE_ACCOUNT_JSON --project "$project_id" \
    | python3 -c 'import base64,sys; print(base64.b64encode(sys.stdin.buffer.read()).decode())'
  )"

  cat > "$WORK_DIR/env/$env_file_name" <<EOF
NODE_ENV=production
PORT=8080
ENABLE_CLOUD_LOGGING=false
GOOGLE_CLOUD_PROJECT=${firebase_project_id}
GCLOUD_PROJECT=${firebase_project_id}
FIREBASE_PROJECT_ID=${firebase_project_id}
FIREBASE_STORAGE_BUCKET=${bucket}
FIREBASE_DATABASE_URL=${database_url}
FIREBASE_SERVICE_ACCOUNT_JSON=${service_account_json_b64}
RUNTIME_ALERT_RECIPIENTS=${runtime_alert_recipients}
SENTRY_DSN=${sentry_dsn}
SENTRY_ENVIRONMENT=${env_name}
SENTRY_RELEASE=process-audio-hetzner@${env_name}-${RELEASE_SHA}
SENTRY_TRACES_SAMPLE_RATE=0.1
SENTRY_ENABLE_LOGS=true
SENTRY_LOG_LEVELS=info,warn,error
PROCESS_AUDIO_RUNTIME_HOST=hetzner
PROCESS_AUDIO_RUNTIME_PROFILE=hetzner
PROCESS_AUDIO_RUNTIME_ENV=${env_name}
PROCESS_AUDIO_YTDLP_VERSION=${PROCESS_AUDIO_YTDLP_VERSION}
PROCESS_AUDIO_FFMPEG_VERSION=${PROCESS_AUDIO_FFMPEG_VERSION}
PROCESS_AUDIO_DENO_VERSION=${PROCESS_AUDIO_DENO_VERSION}
PROCESS_AUDIO_BGUTIL_VERSION=${PROCESS_AUDIO_BGUTIL_VERSION}
PROCESS_AUDIO_BGUTIL_IMAGE=${PROCESS_AUDIO_BGUTIL_IMAGE}
YTDLP_POT_PROVIDER_BASE_URL=http://ytdlp-pot-provider-${env_name}:4416
YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS=false
YTDLP_CONCURRENT_FRAGMENTS=1
YTDLP_EXTERNAL_DOWNLOADER=aria2c
YTDLP_EXTERNAL_DOWNLOADER_ARGS=-x 16 -s 16 -k 1M
YTDLP_M3U8_FFMPEG_DOWNLOADER_ARGS=-reconnect 1 -reconnect_streamed 1 -reconnect_on_network_error 1 -reconnect_on_http_error 4xx,5xx -reconnect_delay_max 5 -http_persistent 1 -http_multiple 1
YOUTUBE_RETRY_DELAY_MS=1500
YTDLP_COOKIE_HEALTHCHECK_ENABLED=true
YTDLP_POT_DISABLE_INNERTUBE=false
YTDLP_JS_RUNTIME=deno
YOUTUBE_PUBLIC_PROVIDER_MAX_ATTEMPTS=1
YOUTUBE_COOKIE_PROVIDER_MAX_ATTEMPTS=1
YOUTUBE_COOKIE_CIRCUIT_BREAKER_MINUTES=30
YTDLP_SLEEP_REQUESTS_SECONDS=2
YTDLP_SLEEP_INTERVAL_SECONDS=1
YTDLP_MAX_SLEEP_INTERVAL_SECONDS=3
YOUTUBE_BROWSER_FALLBACK_ENABLED=true
YOUTUBE_BROWSER_FALLBACK_URL=
YOUTUBE_FINAL_BROWSER_FALLBACK_URL=
YOUTUBE_FORCE_IPV4=false
PROCESS_AUDIO_IN_PROCESS_BROWSER_FALLBACK_ENABLED=true
PROCESS_AUDIO_BROWSER_PROFILE_BROWSER=chrome
PROCESS_AUDIO_BROWSER_PROFILE_DIR=/workspace/shared-browser-profile/.config/google-chrome
PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR=/workspace/browser-refresh-control
PROCESS_AUDIO_BROWSER_POT_CONTROL_DIR=/workspace/browser-refresh-control
PROCESS_AUDIO_BROWSER_FALLBACK_STRATEGY=session_backed
PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL=${public_canary_url}
PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL=${auth_canary_url}
PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_INTERVAL_MS=600000
PROCESS_AUDIO_YOUTUBE_MEDIA_CANARY_MAX_AGE_MS=900000
EOF
  chmod 600 "$WORK_DIR/env/$env_file_name"
}

case "$TARGET_ENV" in
  staging)
    write_env_file staging
    ;;
  production)
    write_env_file production
    ;;
  all)
    write_env_file staging
    write_env_file production
    ;;
esac

cat > "$WORK_DIR/.env" <<EOF
PROCESS_AUDIO_STAGING_HOSTNAME=${staging_hostname}
PROCESS_AUDIO_PRODUCTION_HOSTNAME=${production_hostname}
PROCESS_AUDIO_YTDLP_VERSION=${PROCESS_AUDIO_YTDLP_VERSION}
PROCESS_AUDIO_FFMPEG_VERSION=${PROCESS_AUDIO_FFMPEG_VERSION}
PROCESS_AUDIO_DENO_VERSION=${PROCESS_AUDIO_DENO_VERSION}
PROCESS_AUDIO_BGUTIL_VERSION=${PROCESS_AUDIO_BGUTIL_VERSION}
PROCESS_AUDIO_BGUTIL_IMAGE=${PROCESS_AUDIO_BGUTIL_IMAGE}
EOF

begin_remote_transaction() {
  local attempt_output attempt_status stale_deployment_id
  while true; do
    set +e
    attempt_output="$(ssh "$SSH_TARGET" "bash -s -- '${REMOTE_DIR}' '${TARGET_ENV}' '${DEPLOYMENT_ID}' '${RELEASE_SHA}'" <<'REMOTE_BEGIN_EOF' 2>&1
set -euo pipefail

remote_dir="$1"
target_env="$2"
deployment_id="$3"
release_sha="$4"
lock_dir="${remote_dir}/.deploy-lock"
lock_owner_file="${lock_dir}/deployment-id"
now_epoch="$(date +%s)"
lease_seconds=3600

if ! mkdir "$lock_dir" 2>/dev/null; then
  existing_owner="$(cat "$lock_owner_file" 2>/dev/null || true)"
  lease_expires_at="$(cat "${lock_dir}/lease-expires-at" 2>/dev/null || echo 0)"
  if [[ "$existing_owner" == "$deployment_id" ]]; then
    printf '%s\n' "$((now_epoch + lease_seconds))" >"${lock_dir}/lease-expires-at"
    exit 0
  fi
  if [[ "$lease_expires_at" =~ ^[0-9]+$ ]] && (( lease_expires_at <= now_epoch )) \
    && [[ "$existing_owner" =~ ^[0-9a-f]{12}-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]]; then
    echo "STALE_DEPLOYMENT_ID=${existing_owner}"
    exit 75
  fi
  echo "Another rollout owns ${lock_dir}: deployment=${existing_owner:-unknown}, leaseExpiresAt=${lease_expires_at}" >&2
  exit 73
fi

printf '%s\n' "$deployment_id" >"$lock_owner_file"
printf '%s\n' "$target_env" >"${lock_dir}/target-env"
printf '%s\n' "$release_sha" >"${lock_dir}/source-release-sha"
printf '%s\n' "$now_epoch" >"${lock_dir}/created-at"
printf '%s\n' "$((now_epoch + lease_seconds))" >"${lock_dir}/lease-expires-at"
printf '%s\n' "${SSH_CONNECTION:-local-ssh}" >"${lock_dir}/owner-connection"

rollback_root="${remote_dir}/state/deploy-rollback/${deployment_id}"
snapshot_tree="${rollback_root}/config-before"
mkdir -p "$snapshot_tree"
printf '%s\n' "$target_env" >"${rollback_root}/target-env"

snapshot_entry() {
  local relative_path="$1"
  if [[ -e "${remote_dir}/${relative_path}" ]]; then
    mkdir -p "${snapshot_tree}/$(dirname "$relative_path")"
    cp -a "${remote_dir}/${relative_path}" "${snapshot_tree}/${relative_path}"
    if [[ "$relative_path" == env/*.env ]]; then
      chmod 600 "${remote_dir}/${relative_path}" "${snapshot_tree}/${relative_path}"
      chown "$(id -u):$(id -g)" "${remote_dir}/${relative_path}" "${snapshot_tree}/${relative_path}"
    fi
  fi
}

for relative_path in \
  compose.yaml \
  .env \
  Caddyfile \
  README.md \
  media-runtime-versions.env \
  env/process-audio-staging.env \
  env/process-audio-production.env; do
  snapshot_entry "$relative_path"
done

cd "$remote_dir"
if [[ "$target_env" == "all" ]]; then
  snapshot_envs=(staging production)
else
  snapshot_envs=("$target_env")
fi
for env_name in "${snapshot_envs[@]}"; do
  credential_path="${remote_dir}/state/${env_name}/logs/firebase-service-account.json"
  if [[ -f "$credential_path" ]]; then
    chmod 600 "$credential_path"
    chown 1000:1000 "$credential_path"
  fi
  service_name="process-audio-${env_name}"
  env_rollback_dir="${rollback_root}/${env_name}"
  container_id="$(docker compose ps -q "$service_name")"
  if [[ -z "$container_id" ]] || [[ "$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)" != true ]]; then
    echo "Refusing rollout: ${service_name} has no running image to preserve" >&2
    exit 1
  fi
  image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
  rollback_tag="upperroom/process-audio-${env_name}:rollback-${deployment_id}"
  docker image tag "$image_id" "$rollback_tag"
  mkdir -p "$env_rollback_dir"
  printf '%s\n' "$container_id" >"${env_rollback_dir}/previous-container-id"
  printf '%s\n' "$image_id" >"${env_rollback_dir}/previous-image-id"
  printf '%s\n' "$image_ref" >"${env_rollback_dir}/previous-image-ref"
  printf '%s\n' "$rollback_tag" >"${env_rollback_dir}/rollback-tag"
done

snapshot_runtime_service() {
  local service_name="$1"
  local service_rollback_dir="${rollback_root}/runtime-services/${service_name}"
  local container_id image_id image_ref rollback_tag was_running
  mkdir -p "$service_rollback_dir"
  container_id="$(docker compose ps -a -q "$service_name" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    printf '%s\n' false >"${service_rollback_dir}/was-present"
    return 0
  fi
  image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
  was_running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
  rollback_tag="upperroom/process-audio-runtime-rollback:${deployment_id}-${service_name}"
  docker image tag "$image_id" "$rollback_tag"
  printf '%s\n' true >"${service_rollback_dir}/was-present"
  printf '%s\n' "$was_running" >"${service_rollback_dir}/was-running"
  printf '%s\n' "$container_id" >"${service_rollback_dir}/previous-container-id"
  printf '%s\n' "$image_id" >"${service_rollback_dir}/previous-image-id"
  printf '%s\n' "$image_ref" >"${service_rollback_dir}/previous-image-ref"
  printf '%s\n' "$rollback_tag" >"${service_rollback_dir}/rollback-tag"
}

for env_name in "${snapshot_envs[@]}"; do
  snapshot_runtime_service "ytdlp-pot-provider-${env_name}"
done
snapshot_runtime_service caddy
: >"${rollback_root}/config-snapshot-complete"
echo "Rollout transaction ${deployment_id} acquired lock and preserved previous config/images"
REMOTE_BEGIN_EOF
)"
    attempt_status=$?
    set -e
    printf '%s\n' "$attempt_output"
    if (( attempt_status == 0 )); then
      return 0
    fi
    if (( attempt_status != 75 )); then
      return "$attempt_status"
    fi
    stale_deployment_id="$(printf '%s\n' "$attempt_output" | sed -n 's/^STALE_DEPLOYMENT_ID=//p' | tail -n 1)"
    [[ "$stale_deployment_id" =~ ^[0-9a-f]{12}-[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || {
      echo "Could not parse stale rollout owner" >&2
      return 1
    }
    echo "Recovering expired rollout transaction ${stale_deployment_id} before starting ${DEPLOYMENT_ID}" >&2
    rollback_remote_workers auto "$stale_deployment_id"
  done
}

upload_remote_release() {
  local incoming_dir="${REMOTE_DIR}/state/deploy-incoming/${DEPLOYMENT_ID}"
  ssh "$SSH_TARGET" "mkdir -p '${incoming_dir}'"
  rsync -az --no-owner --no-group --delete "$WORK_DIR/" "${SSH_TARGET}:${incoming_dir}/"
}

activate_remote_release() {
  ssh "$SSH_TARGET" "bash -s -- '${REMOTE_DIR}' '${DEPLOYMENT_ID}'" <<'REMOTE_ACTIVATE_EOF'
set -euo pipefail

remote_dir="$1"
deployment_id="$2"
lock_dir="${remote_dir}/.deploy-lock"
rollback_root="${remote_dir}/state/deploy-rollback/${deployment_id}"
incoming_dir="${remote_dir}/state/deploy-incoming/${deployment_id}"

[[ -f "${lock_dir}/deployment-id" && "$(cat "${lock_dir}/deployment-id")" == "$deployment_id" ]] || {
  echo "Cannot activate release: deployment lock ownership was lost" >&2
  exit 1
}
[[ -f "${rollback_root}/config-snapshot-complete" ]] || { echo "Cannot activate release without completed config snapshot" >&2; exit 1; }
[[ -f "${incoming_dir}/compose.yaml" && -f "${incoming_dir}/.env" && -d "${incoming_dir}/context" ]] || {
  echo "Incoming release ${incoming_dir} is incomplete" >&2
  exit 1
}

atomic_install_file() {
  local source_path="$1"
  local destination_path="$2"
  local temporary_path="${destination_path}.deploy-${deployment_id}"
  mkdir -p "$(dirname "$destination_path")"
  cp -p "$source_path" "$temporary_path"
  mv -f "$temporary_path" "$destination_path"
}

[[ -f "${rollback_root}/runtime-services/caddy/was-present" ]] || {
  echo "Cannot activate release without Caddy rollback metadata" >&2
  exit 1
}
: >"${rollback_root}/runtime-services/caddy/mutation-attempted"
: >"${rollback_root}/config-activation-started"
if [[ -e "${remote_dir}/context" ]]; then
  mv "${remote_dir}/context" "${rollback_root}/config-before/context"
fi
mv "${incoming_dir}/context" "${remote_dir}/context"
for relative_path in compose.yaml .env Caddyfile README.md media-runtime-versions.env; do
  atomic_install_file "${incoming_dir}/${relative_path}" "${remote_dir}/${relative_path}"
done
for env_file in "${incoming_dir}"/env/*.env; do
  [[ -e "$env_file" ]] || continue
  atomic_install_file "$env_file" "${remote_dir}/env/$(basename "$env_file")"
  chmod 600 "${remote_dir}/env/$(basename "$env_file")"
  chown "$(id -u):$(id -g)" "${remote_dir}/env/$(basename "$env_file")"
done

mkdir -p \
  "${remote_dir}/state/staging/tmp" \
  "${remote_dir}/state/staging/logs" \
  "${remote_dir}/state/production/tmp" \
  "${remote_dir}/state/production/logs" \
  "${remote_dir}/state/shared-browser-profile" \
  "${remote_dir}/state/browser-refresh-control"
chmod 755 "$remote_dir" "${remote_dir}/state"
chown -R 1000:1000 \
  "${remote_dir}/state/staging" \
  "${remote_dir}/state/production" \
  "${remote_dir}/state/shared-browser-profile" \
  "${remote_dir}/state/browser-refresh-control"
printf '%s\n' "$(( $(date +%s) + 3600 ))" >"${lock_dir}/lease-expires-at"
: >"${rollback_root}/config-activated"
echo "Atomically activated staged release configuration for ${deployment_id}"
REMOTE_ACTIVATE_EOF
}

deploy_remote_worker() {
  local deploy_env="$1"
  ssh "$SSH_TARGET" "bash -s -- '${REMOTE_DIR}' '${deploy_env}' '${DEPLOYMENT_ID}' '${CANDIDATE_ID}' '${RELEASE_SHA}'" <<'REMOTE_DEPLOY_EOF'
set -euo pipefail

remote_dir="$1"
deploy_env="$2"
deployment_id="$3"
candidate_id="$4"
release_sha="$5"
lock_dir="${remote_dir}/.deploy-lock"
lock_owner_file="${lock_dir}/deployment-id"
rollback_root="${remote_dir}/state/deploy-rollback/${deployment_id}"
candidate_dir="${remote_dir}/state/deploy-candidates/${candidate_id}"
candidate_tag="upperroom/process-audio-candidate:${candidate_id}"

[[ -f "$lock_owner_file" && "$(cat "$lock_owner_file")" == "$deployment_id" ]] || {
  echo "Cannot deploy worker: deployment ${deployment_id} does not own the rollout lock" >&2
  exit 1
}
printf '%s\n' "$(( $(date +%s) + 3600 ))" >"${lock_dir}/lease-expires-at"

cd "$remote_dir"
[[ -f "${rollback_root}/config-activated" ]] || { echo "Release config was not activated for ${deployment_id}" >&2; exit 1; }

wait_for_provider_health() {
  local service_name="$1"
  local container_id health deadline
  container_id="$(docker compose ps -q "$service_name")"
  if [[ -z "$container_id" ]]; then
    echo "Provider container was not created for ${service_name}" >&2
    return 1
  fi

  deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
    if [[ "$health" == "healthy" ]]; then
      return 0
    fi
    if [[ "$health" == "unhealthy" ]]; then
      docker logs --tail=100 "$container_id" >&2 || true
      echo "Provider ${service_name} is unhealthy" >&2
      return 1
    fi
    sleep 2
  done

  docker logs --tail=100 "$container_id" >&2 || true
  echo "Timed out waiting for provider ${service_name} to become healthy" >&2
  return 1
}

wait_for_worker_health() {
  local service_name="$1"
  local container_id deadline response
  container_id="$(docker compose ps -q "$service_name")"
  if [[ -z "$container_id" ]]; then
    echo "Worker container was not created for ${service_name}" >&2
    return 1
  fi

  deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)" == "true" ]] \
      && response="$(docker exec "$container_id" curl -fsS http://127.0.0.1:8080/healthz 2>/dev/null)" \
      && [[ "$response" == *'"ok":true'* ]]; then
      return 0
    fi
    sleep 3
  done

  docker logs --tail=100 "$container_id" >&2 || true
  echo "Timed out waiting for worker ${service_name} health" >&2
  return 1
}

mark_replacement_attempted() {
  local env_name="$1"
  : >"${rollback_root}/${env_name}/replacement-attempted"
}

mark_runtime_mutation_attempted() {
  local service_name="$1"
  local service_rollback_dir="${rollback_root}/runtime-services/${service_name}"
  [[ -f "${service_rollback_dir}/was-present" ]] || {
    echo "Missing pre-activation rollback metadata for runtime service ${service_name}" >&2
    return 1
  }
  : >"${service_rollback_dir}/mutation-attempted"
}

provider_service="ytdlp-pot-provider-${deploy_env}"
worker_service="process-audio-${deploy_env}"
worker_image_ref="upperroom/process-audio-${deploy_env}:current"
mark_runtime_mutation_attempted "$provider_service"
docker compose up -d "$provider_service"
wait_for_provider_health "$provider_service"
[[ -f "${rollback_root}/${deploy_env}/previous-image-id" ]] || {
  echo "Missing pre-activation rollback image metadata for ${worker_service}" >&2
  exit 1
}

if [[ "$deploy_env" == "staging" ]]; then
  mkdir -p "$candidate_dir"
  rm -f "${candidate_dir}/validated"
  # Staging is the only environment allowed to build the candidate. Production
  # promotes the recorded image ID without rebuilding it.
  docker compose build "$worker_service"
  candidate_image_id="$(docker image inspect --format '{{.Id}}' "$worker_image_ref")"
  docker image tag "$candidate_image_id" "$candidate_tag"
  printf '%s\n' "$candidate_image_id" >"${candidate_dir}/image-id"
  printf '%s\n' "$candidate_id" >"${candidate_dir}/context-sha256"
  printf '%s\n' "$release_sha" >"${candidate_dir}/source-release-sha"
  printf '%s\n' "$candidate_tag" >"${candidate_dir}/image-ref"
  echo "Built staging candidate ${candidate_tag} at immutable image ID ${candidate_image_id}"
else
  if [[ ! -f "${candidate_dir}/validated" || ! -f "${candidate_dir}/image-id" ]]; then
    echo "Production promotion refused: candidate ${candidate_id} has not passed staging validation" >&2
    exit 1
  fi
  candidate_image_id="$(cat "${candidate_dir}/image-id")"
  resolved_candidate_image_id="$(docker image inspect --format '{{.Id}}' "$candidate_tag" 2>/dev/null || true)"
  if [[ -z "$resolved_candidate_image_id" || "$resolved_candidate_image_id" != "$candidate_image_id" ]]; then
    echo "Production promotion refused: ${candidate_tag} does not resolve to recorded image ${candidate_image_id}" >&2
    exit 1
  fi
  docker image tag "$candidate_image_id" "$worker_image_ref"
  echo "Promoting staging-validated candidate ${candidate_tag} (${candidate_image_id}) to production without rebuild"
fi

mark_replacement_attempted "$deploy_env"
docker compose up -d --no-deps --no-build "$worker_service"
deployed_container_id="$(docker compose ps -q "$worker_service")"
deployed_image_id="$(docker inspect --format '{{.Image}}' "$deployed_container_id" 2>/dev/null || true)"
if [[ "$deployed_image_id" != "$candidate_image_id" ]]; then
  echo "Candidate image mismatch for ${worker_service}: expected ${candidate_image_id}, got ${deployed_image_id:-missing}" >&2
  exit 1
fi
wait_for_worker_health "$worker_service"
mark_runtime_mutation_attempted caddy
docker compose up -d --no-deps caddy
REMOTE_DEPLOY_EOF
}

mark_staging_candidate_validated() {
  ssh "$SSH_TARGET" "bash -s -- '${REMOTE_DIR}' '${DEPLOYMENT_ID}' '${CANDIDATE_ID}'" <<'REMOTE_VALIDATE_EOF'
set -euo pipefail

remote_dir="$1"
deployment_id="$2"
candidate_id="$3"
lock_owner_file="${remote_dir}/.deploy-lock/deployment-id"
lock_dir="${remote_dir}/.deploy-lock"
candidate_dir="${remote_dir}/state/deploy-candidates/${candidate_id}"
candidate_tag="upperroom/process-audio-candidate:${candidate_id}"

cd "$remote_dir"
[[ -f "$lock_owner_file" && "$(cat "$lock_owner_file")" == "$deployment_id" ]] || {
  echo "Cannot validate staging candidate: deployment ${deployment_id} does not own the rollout lock" >&2
  exit 1
}
printf '%s\n' "$(( $(date +%s) + 3600 ))" >"${lock_dir}/lease-expires-at"
[[ -f "${candidate_dir}/image-id" ]] || { echo "Candidate ${candidate_id} has no recorded image ID" >&2; exit 1; }

candidate_image_id="$(cat "${candidate_dir}/image-id")"
resolved_candidate_image_id="$(docker image inspect --format '{{.Id}}' "$candidate_tag" 2>/dev/null || true)"
staging_container_id="$(docker compose ps -q process-audio-staging)"
staging_image_id="$(docker inspect --format '{{.Image}}' "$staging_container_id" 2>/dev/null || true)"
if [[ "$resolved_candidate_image_id" != "$candidate_image_id" || "$staging_image_id" != "$candidate_image_id" ]]; then
  echo "Staging validation digest mismatch: recorded=${candidate_image_id}, tag=${resolved_candidate_image_id:-missing}, container=${staging_image_id:-missing}" >&2
  exit 1
fi

printf '%s\n' "$deployment_id" >"${candidate_dir}/validated-by-deployment"
date -u +%Y-%m-%dT%H:%M:%SZ >"${candidate_dir}/validated-at"
: >"${candidate_dir}/validated"
echo "Recorded staging validation for ${candidate_tag} at image ID ${candidate_image_id}"
REMOTE_VALIDATE_EOF
}

rollback_remote_workers() {
  local rollback_target="${1:-$TARGET_ENV}"
  local rollback_deployment_id="${2:-$DEPLOYMENT_ID}"
  ssh "$SSH_TARGET" "bash -s -- '${REMOTE_DIR}' '${rollback_target}' '${rollback_deployment_id}'" <<'REMOTE_ROLLBACK_EOF'
set -euo pipefail

remote_dir="$1"
target_env="$2"
deployment_id="$3"
rollback_root="${remote_dir}/state/deploy-rollback/${deployment_id}"
lock_dir="${remote_dir}/.deploy-lock"
lock_owner_file="${lock_dir}/deployment-id"
rollback_failed=false
replacement_attempted=false

cd "$remote_dir"

if [[ -d "$rollback_root" ]]; then
  [[ -f "$lock_owner_file" && "$(cat "$lock_owner_file")" == "$deployment_id" ]] || {
    echo "Automatic rollback refused: deployment ${deployment_id} does not own the rollout lock" >&2
    exit 1
  }
elif [[ ! -e "$lock_dir" ]]; then
  echo "Deployment failed before a remote replacement transaction was created; rollback was not required" >&2
  exit 0
else
  echo "Automatic rollback refused: rollout lock exists without this deployment's rollback metadata" >&2
  exit 1
fi

if [[ "$target_env" == auto ]]; then
  target_env="$(cat "${rollback_root}/target-env" 2>/dev/null || true)"
  [[ "$target_env" == staging || "$target_env" == production || "$target_env" == all ]] || {
    echo "Automatic rollback metadata has invalid target environment: ${target_env:-missing}" >&2
    exit 1
  }
fi

restore_config_snapshot() {
  local snapshot_tree="${rollback_root}/config-before"
  local relative_path source_path destination_path temporary_path
  [[ -f "${rollback_root}/config-snapshot-complete" ]] || {
    if [[ ! -f "${rollback_root}/config-activation-started" ]]; then
      echo "Configuration activation never started; active config remains unchanged" >&2
      return 0
    fi
    echo "Cannot restore activated configuration: snapshot is incomplete" >&2
    return 1
  }

  if [[ -f "${rollback_root}/config-activation-started" && ! -f "${rollback_root}/config-restored" ]]; then
    if [[ -e "${remote_dir}/context" ]]; then
      mv "${remote_dir}/context" "${rollback_root}/failed-context-$(date +%s)"
    fi
    if [[ -d "${snapshot_tree}/context" ]]; then
      cp -a "${snapshot_tree}/context" "${remote_dir}/context"
    fi
  fi

  for relative_path in \
    compose.yaml \
    .env \
    Caddyfile \
    README.md \
    media-runtime-versions.env \
    env/process-audio-staging.env \
    env/process-audio-production.env; do
    source_path="${snapshot_tree}/${relative_path}"
    destination_path="${remote_dir}/${relative_path}"
    if [[ -e "$source_path" ]]; then
      temporary_path="${destination_path}.rollback-${deployment_id}"
      mkdir -p "$(dirname "$destination_path")"
      cp -p "$source_path" "$temporary_path"
      mv -f "$temporary_path" "$destination_path"
      if [[ "$relative_path" == env/*.env ]]; then
        chmod 600 "$destination_path"
        chown "$(id -u):$(id -g)" "$destination_path"
      fi
    else
      rm -f "$destination_path"
    fi
  done
  : >"${rollback_root}/config-restored"
  echo "Restored exact pre-rollout Compose and environment configuration for ${deployment_id}" >&2
}

if ! restore_config_snapshot; then
  echo "AUTOMATIC ROLLBACK FAILED before image restore: previous configuration could not be restored" >&2
  exit 1
fi

wait_for_worker_health() {
  local service_name="$1"
  local container_id deadline response
  container_id="$(docker compose ps -q "$service_name")"
  [[ -n "$container_id" ]] || { echo "Rollback did not create ${service_name}" >&2; return 1; }

  deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)" == "true" ]] \
      && response="$(docker exec "$container_id" curl -fsS http://127.0.0.1:8080/healthz 2>/dev/null)" \
      && [[ "$response" == *'"ok":true'* ]]; then
      return 0
    fi
    sleep 3
  done

  docker logs --tail=100 "$container_id" >&2 || true
  echo "Rolled-back worker ${service_name} did not become healthy" >&2
  return 1
}

wait_for_runtime_service() {
  local service_name="$1"
  local require_provider_health="$2"
  local container_id deadline health
  container_id="$(docker compose ps -q "$service_name")"
  [[ -n "$container_id" ]] || { echo "Rollback did not create runtime service ${service_name}" >&2; return 1; }
  deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)" == true ]]; then
      if [[ "$require_provider_health" == false ]]; then
        return 0
      fi
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$health" == healthy ]]; then
        return 0
      fi
      [[ "$health" != unhealthy ]] || break
    fi
    sleep 3
  done
  docker logs --tail=100 "$container_id" >&2 || true
  echo "Restored runtime service ${service_name} did not become ready" >&2
  return 1
}

restore_runtime_service() {
  local service_name="$1"
  local require_provider_health="$2"
  local service_rollback_dir="${rollback_root}/runtime-services/${service_name}"
  local was_present was_running previous_image_id previous_image_ref rollback_tag restored_container_id restored_image_id
  local -a replacement_container_ids=()

  [[ -f "${service_rollback_dir}/mutation-attempted" ]] || return 0
  replacement_attempted=true
  was_present="$(cat "${service_rollback_dir}/was-present" 2>/dev/null || true)"
  if [[ "$was_present" == false ]]; then
    mapfile -t replacement_container_ids < <(
      docker ps -aq \
        --filter label=com.docker.compose.project=process-audio-hetzner \
        --filter "label=com.docker.compose.service=${service_name}"
    )
    if (( ${#replacement_container_ids[@]} > 0 )); then
      docker rm -f "${replacement_container_ids[@]}" >/dev/null
    fi
    echo "Rollback restored ${service_name} to its prior absent state" >&2
    return 0
  fi
  if [[ "$was_present" != true \
    || ! -f "${service_rollback_dir}/was-running" \
    || ! -f "${service_rollback_dir}/previous-image-id" \
    || ! -f "${service_rollback_dir}/previous-image-ref" \
    || ! -f "${service_rollback_dir}/rollback-tag" ]]; then
    echo "Rollback metadata is incomplete for runtime service ${service_name}" >&2
    return 1
  fi

  was_running="$(cat "${service_rollback_dir}/was-running")"
  previous_image_id="$(cat "${service_rollback_dir}/previous-image-id")"
  previous_image_ref="$(cat "${service_rollback_dir}/previous-image-ref")"
  rollback_tag="$(cat "${service_rollback_dir}/rollback-tag")"
  docker image inspect "$rollback_tag" >/dev/null
  if [[ "$previous_image_ref" != *@sha256:* ]]; then
    docker image tag "$rollback_tag" "$previous_image_ref"
  else
    [[ "$(docker image inspect --format '{{.Id}}' "$previous_image_ref" 2>/dev/null || true)" == "$previous_image_id" ]] || {
      echo "Pinned prior image ${previous_image_ref} no longer resolves to ${previous_image_id}" >&2
      return 1
    }
  fi

  docker compose up -d --no-deps --force-recreate --no-build "$service_name"
  restored_container_id="$(docker compose ps -a -q "$service_name")"
  restored_image_id="$(docker inspect --format '{{.Image}}' "$restored_container_id" 2>/dev/null || true)"
  [[ "$restored_image_id" == "$previous_image_id" ]] || {
    echo "Runtime rollback image mismatch for ${service_name}: expected ${previous_image_id}, got ${restored_image_id:-missing}" >&2
    return 1
  }
  if [[ "$was_running" == true ]]; then
    wait_for_runtime_service "$service_name" "$require_provider_health"
  else
    docker compose stop "$service_name"
    [[ "$(docker inspect --format '{{.State.Running}}' "$restored_container_id" 2>/dev/null || true)" == false ]]
  fi
  echo "Rollback restored ${service_name} on image ${previous_image_id} with prior running state ${was_running}" >&2
}

if [[ "$target_env" == "all" ]]; then
  rollback_envs=(staging production)
else
  rollback_envs=("$target_env")
fi

for env_name in "${rollback_envs[@]}"; do
  if ! restore_runtime_service "ytdlp-pot-provider-${env_name}" true; then
    rollback_failed=true
  fi
done

for env_name in "${rollback_envs[@]}"; do
  service_name="process-audio-${env_name}"
  env_rollback_dir="${rollback_root}/${env_name}"
  if [[ ! -f "${env_rollback_dir}/replacement-attempted" ]]; then
    if [[ -f "${env_rollback_dir}/rollback-tag" ]]; then
      rollback_tag="$(cat "${env_rollback_dir}/rollback-tag")"
      docker image rm "$rollback_tag" >/dev/null 2>&1 || true
    fi
    echo "No replacement was attempted for ${service_name}; its running container was left unchanged"
    continue
  fi

  replacement_attempted=true
  if [[ ! -f "${env_rollback_dir}/previous-image-id" \
    || ! -f "${env_rollback_dir}/previous-image-ref" \
    || ! -f "${env_rollback_dir}/rollback-tag" ]]; then
    echo "Rollback metadata is incomplete for ${service_name}" >&2
    rollback_failed=true
    continue
  fi

  previous_image_id="$(cat "${env_rollback_dir}/previous-image-id")"
  previous_image_ref="$(cat "${env_rollback_dir}/previous-image-ref")"
  rollback_tag="$(cat "${env_rollback_dir}/rollback-tag")"
  echo "Rolling back ${service_name} to ${previous_image_id} (${rollback_tag})" >&2

  if ! docker image inspect "$rollback_tag" >/dev/null 2>&1 \
    || ! docker image tag "$rollback_tag" "$previous_image_ref" \
    || ! docker compose up -d --no-deps --force-recreate --no-build "$service_name"; then
    echo "Failed to recreate ${service_name} from preserved image ${rollback_tag}" >&2
    rollback_failed=true
    continue
  fi

  restored_container_id="$(docker compose ps -q "$service_name")"
  restored_image_id="$(docker inspect --format '{{.Image}}' "$restored_container_id" 2>/dev/null || true)"
  if [[ "$restored_image_id" != "$previous_image_id" ]]; then
    echo "Rollback image mismatch for ${service_name}: expected ${previous_image_id}, got ${restored_image_id:-missing}" >&2
    rollback_failed=true
    continue
  fi

  if ! wait_for_worker_health "$service_name"; then
    rollback_failed=true
    continue
  fi
  echo "Rollback restored healthy ${service_name} on image ${previous_image_id}" >&2
done

if ! restore_runtime_service caddy false; then
  rollback_failed=true
fi

remove_rollback_image_tags() {
  local rollback_tag_file
  while IFS= read -r -d '' rollback_tag_file; do
    docker image rm "$(cat "$rollback_tag_file")" >/dev/null 2>&1 || true
  done < <(find "$rollback_root" -type f -name rollback-tag -print0)
}

if [[ "$replacement_attempted" == "false" ]]; then
  remove_rollback_image_tags
  rm -rf "${remote_dir}/state/deploy-incoming/${deployment_id}"
  rm -rf "$rollback_root"
  rm -f "$lock_owner_file" "${lock_dir}/target-env" "${lock_dir}/source-release-sha" "${lock_dir}/created-at" "${lock_dir}/lease-expires-at" "${lock_dir}/owner-connection"
  rmdir "$lock_dir"
  echo "Deployment failed before worker replacement; rollback was not required" >&2
  exit 0
fi

if [[ "$rollback_failed" == "true" ]]; then
  echo "AUTOMATIC ROLLBACK FAILED for deployment ${deployment_id}; operator intervention is required" >&2
  exit 1
fi

remove_rollback_image_tags
rm -rf "${remote_dir}/state/deploy-incoming/${deployment_id}"
rm -rf "$rollback_root"
rm -f "$lock_owner_file" "${lock_dir}/target-env" "${lock_dir}/source-release-sha" "${lock_dir}/created-at" "${lock_dir}/lease-expires-at" "${lock_dir}/owner-connection"
rmdir "$lock_dir"
echo "Automatic rollback completed for deployment ${deployment_id}" >&2
REMOTE_ROLLBACK_EOF
}

finalize_remote_deployment() {
  ssh "$SSH_TARGET" "bash -s -- '${REMOTE_DIR}' '${TARGET_ENV}' '${DEPLOYMENT_ID}'" <<'REMOTE_FINALIZE_EOF'
set -euo pipefail

remote_dir="$1"
target_env="$2"
deployment_id="$3"
rollback_root="${remote_dir}/state/deploy-rollback/${deployment_id}"
lock_dir="${remote_dir}/.deploy-lock"
lock_owner_file="${lock_dir}/deployment-id"

[[ -f "$lock_owner_file" && "$(cat "$lock_owner_file")" == "$deployment_id" ]] || {
  echo "Cannot finalize deployment ${deployment_id}: rollout lock ownership was lost" >&2
  exit 1
}

if [[ "$target_env" == "all" ]]; then
  deployed_envs=(staging production)
else
  deployed_envs=("$target_env")
fi

for env_name in "${deployed_envs[@]}"; do
  rollback_tag_file="${rollback_root}/${env_name}/rollback-tag"
  if [[ -f "$rollback_tag_file" ]]; then
    docker image rm "$(cat "$rollback_tag_file")" >/dev/null 2>&1 || true
  fi
done
while IFS= read -r -d '' rollback_tag_file; do
  docker image rm "$(cat "$rollback_tag_file")" >/dev/null 2>&1 || true
done < <(find "${rollback_root}/runtime-services" -type f -name rollback-tag -print0 2>/dev/null)
rm -rf "$rollback_root"
rm -rf "${remote_dir}/state/deploy-incoming/${deployment_id}"
rm -f "$lock_owner_file" "${lock_dir}/target-env" "${lock_dir}/source-release-sha" "${lock_dir}/created-at" "${lock_dir}/lease-expires-at" "${lock_dir}/owner-connection"
rmdir "$lock_dir"
REMOTE_FINALIZE_EOF
}

set +e
(
  set -e
  begin_remote_transaction
  upload_remote_release
  activate_remote_release
  case "$TARGET_ENV" in
    staging)
      deploy_remote_worker staging
      ensure_browser_auth_stack
      bash "$ROOT_DIR/scripts/verify-hetzner-ytdlp-smoke.sh" staging
      mark_staging_candidate_validated
      ;;
    production)
      deploy_remote_worker production
      ensure_browser_auth_stack
      bash "$ROOT_DIR/scripts/verify-hetzner-ytdlp-smoke.sh" production
      ;;
    all)
      deploy_remote_worker staging
      ensure_browser_auth_stack
      bash "$ROOT_DIR/scripts/verify-hetzner-ytdlp-smoke.sh" staging
      mark_staging_candidate_validated
      deploy_remote_worker production
      ensure_browser_auth_stack
      bash "$ROOT_DIR/scripts/verify-hetzner-ytdlp-smoke.sh" production
      ;;
  esac
)
deployment_status=$?
set -e

if (( deployment_status != 0 )); then
  echo "Post-replacement deployment verification failed with status ${deployment_status}; starting automatic rollback" >&2
  set +e
  rollback_remote_workers
  rollback_status=$?
  set -e
  if (( rollback_status != 0 )); then
    echo "Deployment failed and automatic rollback also failed; inspect ${REMOTE_DIR}/state/deploy-rollback/${DEPLOYMENT_ID} on ${SSH_TARGET}" >&2
  else
    echo "Deployment failed; automatic recovery completed and every replaced worker was restored and health-checked" >&2
  fi
  exit "$deployment_status"
fi

finalize_remote_deployment

echo "Deployed process-audio Hetzner stack for ${TARGET_ENV} to ${SSH_TARGET}:${REMOTE_DIR}"
