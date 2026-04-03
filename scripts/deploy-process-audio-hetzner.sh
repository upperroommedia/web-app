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

if [[ -z "$SSH_TARGET" ]]; then
  echo "PROCESS_AUDIO_HETZNER_SSH_TARGET is required" >&2
  exit 66
fi

staging_hostname="${PROCESS_AUDIO_HETZNER_STAGING_HOSTNAME:-}"
production_hostname="${PROCESS_AUDIO_HETZNER_PRODUCTION_HOSTNAME:-}"

if [[ -z "$staging_hostname" || -z "$production_hostname" ]]; then
  echo "Both PROCESS_AUDIO_HETZNER_STAGING_HOSTNAME and PROCESS_AUDIO_HETZNER_PRODUCTION_HOSTNAME are required" >&2
  exit 67
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/env" "$WORK_DIR/state/caddy/data" "$WORK_DIR/state/caddy/config"
cp "$ROOT_DIR/ops/process-audio-hetzner/compose.yaml" "$WORK_DIR/compose.yaml"
cp "$ROOT_DIR/ops/process-audio-hetzner/Caddyfile" "$WORK_DIR/Caddyfile"
cp "$ROOT_DIR/ops/process-audio-hetzner/README.md" "$WORK_DIR/README.md"

"$ROOT_DIR/scripts/prepare-process-audio-hetzner-context.sh" "$WORK_DIR/context"

write_env_file() {
  local env_name="$1"
  local project_id firebase_project_id bucket database_url env_file_name runtime_alert_recipients pot_provider_url service_account_json_b64

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
  pot_provider_url="$(gcloud run services describe ytdlp-pot-provider --region=us-central1 --project "$project_id" --format='value(status.url)')"
  service_account_json_b64="$(
    gcloud secrets versions access latest --secret=BROWSER_FALLBACK_FIREBASE_SERVICE_ACCOUNT_JSON --project "$project_id" \
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
YTDLP_POT_PROVIDER_BASE_URL=${pot_provider_url}
YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS=false
YTDLP_CONCURRENT_FRAGMENTS=1
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
YOUTUBE_BROWSER_FALLBACK_ENABLED=false
YOUTUBE_BROWSER_FALLBACK_URL=
YOUTUBE_FINAL_BROWSER_FALLBACK_URL=
YOUTUBE_FORCE_IPV4=false
EOF
}

write_env_file staging
write_env_file production

cat > "$WORK_DIR/.env" <<EOF
PROCESS_AUDIO_STAGING_HOSTNAME=${staging_hostname}
PROCESS_AUDIO_PRODUCTION_HOSTNAME=${production_hostname}
EOF

rsync -az --delete "$WORK_DIR/" "${SSH_TARGET}:${REMOTE_DIR}/"

ssh "$SSH_TARGET" "mkdir -p ${REMOTE_DIR}/state/staging/tmp ${REMOTE_DIR}/state/staging/logs ${REMOTE_DIR}/state/production/tmp ${REMOTE_DIR}/state/production/logs && chown -R 1000:1000 ${REMOTE_DIR}/state/staging ${REMOTE_DIR}/state/production"
if [[ "$TARGET_ENV" == "all" ]]; then
  ssh "$SSH_TARGET" "cd ${REMOTE_DIR} && docker compose up -d --build"
else
  ssh "$SSH_TARGET" "cd ${REMOTE_DIR} && docker compose up -d --build caddy process-audio-${TARGET_ENV}"
fi

echo "Deployed process-audio Hetzner stack for ${TARGET_ENV} to ${SSH_TARGET}:${REMOTE_DIR}"
