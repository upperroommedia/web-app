#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <staging|production|all>" >&2
  exit 64
fi

TARGET_ENV="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_TARGET="${BROWSER_FALLBACK_HOME_SSH_TARGET:-asaad@172.26.14.162}"
REMOTE_DIR="${BROWSER_FALLBACK_HOME_REMOTE_DIR:-~/browser-fallback-home}"
HEALTHCHECK_URL="${BROWSER_FALLBACK_HEALTHCHECK_YOUTUBE_URL:-https://youtu.be/dKaZ89SkVYY}"

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

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/env" "$WORK_DIR/tunnels"
cp "$ROOT_DIR/ops/browser-fallback-home/compose.yaml" "$WORK_DIR/compose.yaml"
cp "$ROOT_DIR/ops/browser-fallback-home/README.md" "$WORK_DIR/README.md"
cp "$ROOT_DIR/ops/browser-fallback-home/tunnels/browser-fallback-staging.yml" "$WORK_DIR/tunnels/browser-fallback-staging.yml"
cp "$ROOT_DIR/ops/browser-fallback-home/tunnels/browser-fallback-production.yml" "$WORK_DIR/tunnels/browser-fallback-production.yml"

"$ROOT_DIR/scripts/prepare-browser-fallback-home-context.sh" "$WORK_DIR/context"

write_env_file() {
  local env_name="$1"
  local project_id firebase_project_id bucket database_url port role tunnel_credentials_name

  if [[ "$env_name" == "staging" ]]; then
    project_id="urm-app-staging"
    firebase_project_id="urm-app-staging"
    bucket="urm-app-staging.firebasestorage.app"
    database_url="https://urm-app-staging-default-rtdb.firebaseio.com/"
    port="8090"
    role="linux_public_final_resort_staging"
    tunnel_credentials_name="e2e168f5-5dbc-4048-834e-a38084a8b85b.json"
  else
    project_id="urm-app"
    firebase_project_id="urm-app"
    bucket="urm-app.appspot.com"
    database_url="https://urm-app-default-rtdb.firebaseio.com/"
    port="8091"
    role="linux_public_final_resort_production"
    tunnel_credentials_name="49665e85-59a9-4323-b92c-4e1db0e4c33e.json"
  fi

  local shared_secret
  local service_account_json_b64
  shared_secret="$(gcloud secrets versions access latest --secret=BROWSER_FALLBACK_SHARED_SECRET --project "$project_id")"
  service_account_json_b64="$(
    gcloud secrets versions access latest --secret=BROWSER_FALLBACK_FIREBASE_SERVICE_ACCOUNT_JSON --project "$project_id" \
      | python3 -c 'import base64,sys; print(base64.b64encode(sys.stdin.buffer.read()).decode())'
  )"

  cp "$HOME/.cloudflared/$tunnel_credentials_name" "$WORK_DIR/tunnels/$tunnel_credentials_name"

  cat > "$WORK_DIR/env/browser-fallback-${env_name}.env" <<EOF
NODE_ENV=production
PORT=${port}
FIREBASE_PROJECT_ID=${firebase_project_id}
FIREBASE_STORAGE_BUCKET=${bucket}
FIREBASE_DATABASE_URL=${database_url}
BROWSER_FALLBACK_PROFILE_BUCKET=${bucket}
BROWSER_FALLBACK_ARTIFACT_PREFIX=browser-fallback/artifacts
BROWSER_FALLBACK_HEALTHCHECK_YOUTUBE_URL=${HEALTHCHECK_URL}
BROWSER_FALLBACK_SHARED_SECRET=${shared_secret}
FIREBASE_SERVICE_ACCOUNT_JSON=${service_account_json_b64}
BROWSER_FALLBACK_STRATEGY=public_only
BROWSER_FALLBACK_SERVICE_ROLE=${role}
YTDLP_JS_RUNTIME=deno
YTDLP_SLEEP_REQUESTS_SECONDS=2
YTDLP_SLEEP_INTERVAL_SECONDS=1
YTDLP_MAX_SLEEP_INTERVAL_SECONDS=3
EOF
}

if [[ "$TARGET_ENV" == "staging" || "$TARGET_ENV" == "all" ]]; then
  write_env_file staging
fi

if [[ "$TARGET_ENV" == "production" || "$TARGET_ENV" == "all" ]]; then
  write_env_file production
fi

rsync -az --delete "$WORK_DIR/" "${SSH_TARGET}:${REMOTE_DIR}/"

if [[ "$TARGET_ENV" == "all" ]]; then
  ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes "$SSH_TARGET" "cd ${REMOTE_DIR} && docker compose --profile staging --profile production up -d --build"
else
  ssh -i ~/.ssh/id_rsa -o IdentitiesOnly=yes "$SSH_TARGET" "cd ${REMOTE_DIR} && docker compose --profile ${TARGET_ENV} up -d --build"
fi

echo "Deployed browser-fallback home-host stack for ${TARGET_ENV} to ${SSH_TARGET}:${REMOTE_DIR}"
