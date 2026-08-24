#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_SCRIPT="$ROOT_DIR/scripts/deploy-process-audio-hetzner.sh"
TEST_DIR="$(mktemp -d /tmp/process-audio-rollback-test.XXXXXX)"
trap 'find "$TEST_DIR" -depth -delete' EXIT

REMOTE_DIR="$TEST_DIR/remote"
MOCK_BIN="$TEST_DIR/bin"
MOCK_DOCKER_STATE="$TEST_DIR/docker-state"
DEPLOYMENT_ID=0123456789ab-20260824T010203Z-123
ROLLBACK_ROOT="$REMOTE_DIR/state/deploy-rollback/$DEPLOYMENT_ID"
SNAPSHOT_ROOT="$ROLLBACK_ROOT/config-before"
mkdir -p "$MOCK_BIN" "$MOCK_DOCKER_STATE/services" "$SNAPSHOT_ROOT/env" "$SNAPSHOT_ROOT/context" "$REMOTE_DIR/env" "$REMOTE_DIR/context" "$REMOTE_DIR/.deploy-lock"

extract_rollback_program() {
  awk '
    /<<.REMOTE_ROLLBACK_EOF./ { copying = 1; next }
    copying && /^REMOTE_ROLLBACK_EOF$/ { exit }
    copying { print }
  ' "$DEPLOY_SCRIPT"
}
extract_rollback_program >"$TEST_DIR/rollback-program.sh"
[[ -s "$TEST_DIR/rollback-program.sh" ]] || { echo "Could not extract remote rollback program" >&2; exit 1; }

for relative_path in compose.yaml .env Caddyfile README.md media-runtime-versions.env; do
  printf 'previous-%s\n' "$relative_path" >"$SNAPSHOT_ROOT/$relative_path"
  printf 'candidate-%s\n' "$relative_path" >"$REMOTE_DIR/$relative_path"
done
for env_name in staging production; do
  printf 'previous-secret-%s\n' "$env_name" >"$SNAPSHOT_ROOT/env/process-audio-${env_name}.env"
  printf 'candidate-secret-%s\n' "$env_name" >"$REMOTE_DIR/env/process-audio-${env_name}.env"
  chmod 644 "$SNAPSHOT_ROOT/env/process-audio-${env_name}.env" "$REMOTE_DIR/env/process-audio-${env_name}.env"
done
printf 'previous-context\n' >"$SNAPSHOT_ROOT/context/version"
printf 'candidate-context\n' >"$REMOTE_DIR/context/version"
printf '%s\n' "$DEPLOYMENT_ID" >"$REMOTE_DIR/.deploy-lock/deployment-id"
printf staging >"$ROLLBACK_ROOT/target-env"
: >"$ROLLBACK_ROOT/config-snapshot-complete"
: >"$ROLLBACK_ROOT/config-activation-started"

mkdir -p "$ROLLBACK_ROOT/staging"
printf old-worker-rollback >"$ROLLBACK_ROOT/staging/rollback-tag"

prepare_runtime_rollback() {
  local service_name="$1"
  local image_id="$2"
  local image_ref="$3"
  local rollback_tag="$4"
  local service_dir="$ROLLBACK_ROOT/runtime-services/$service_name"
  mkdir -p "$service_dir"
  printf true >"$service_dir/was-present"
  printf true >"$service_dir/was-running"
  printf '%s\n' "$image_id" >"$service_dir/previous-image-id"
  printf '%s\n' "$image_ref" >"$service_dir/previous-image-ref"
  printf '%s\n' "$rollback_tag" >"$service_dir/rollback-tag"
  : >"$service_dir/mutation-attempted"
  printf '%s|%s\n' "$rollback_tag" "$image_id" >>"$MOCK_DOCKER_STATE/image-refs"
  printf 'candidate-%s\n' "$service_name" >"$MOCK_DOCKER_STATE/services/$service_name"
}
prepare_runtime_rollback ytdlp-pot-provider-staging sha256:old-provider provider:old runtime-rollback:provider
prepare_runtime_rollback caddy sha256:old-caddy caddy:old runtime-rollback:caddy

cat >"$MOCK_BIN/docker" <<'MOCK_DOCKER_EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${MOCK_DOCKER_STATE:?}"

lookup_ref() {
  awk -F '|' -v ref="$1" '$1 == ref { value = $2 } END { print value }' "$state/image-refs"
}

if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$3" == --format ]]; then
    image_id="$(lookup_ref "$5")"
    [[ -n "$image_id" ]] || exit 1
    printf '%s\n' "$image_id"
  else
    [[ -n "$(lookup_ref "$3")" ]]
  fi
  exit 0
fi
if [[ "$1" == image && "$2" == tag ]]; then
  image_id="$(lookup_ref "$3")"
  [[ -n "$image_id" ]] || exit 1
  printf '%s|%s\n' "$4" "$image_id" >>"$state/image-refs"
  exit 0
fi
if [[ "$1" == image && "$2" == rm ]]; then
  exit 0
fi
if [[ "$1" == compose && "$2" == up ]]; then
  service_name="${!#}"
  case "$service_name" in
    ytdlp-pot-provider-staging) image_ref=provider:old ;;
    caddy) image_ref=caddy:old ;;
    *) exit 1 ;;
  esac
  image_id="$(lookup_ref "$image_ref")"
  [[ -n "$image_id" ]] || exit 1
  printf '%s\n' "$image_id" >"$state/services/$service_name"
  exit 0
fi
if [[ "$1" == compose && "$2" == ps ]]; then
  service_name="${!#}"
  [[ -f "$state/services/$service_name" ]] && printf 'container-%s\n' "$service_name"
  exit 0
fi
if [[ "$1" == inspect && "$2" == --format ]]; then
  container_id="$4"
  service_name="${container_id#container-}"
  case "$3" in
    *State.Running*) printf 'true\n' ;;
    *State.Health*) printf 'healthy\n' ;;
    *Image*) cat "$state/services/$service_name" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "$1" == logs ]]; then
  exit 0
fi
if [[ "$1" == ps ]]; then
  exit 0
fi
if [[ "$1" == rm ]]; then
  exit 0
fi
echo "Unexpected mock docker invocation: $*" >&2
exit 1
MOCK_DOCKER_EOF
chmod +x "$MOCK_BIN/docker"

MOCK_DOCKER_STATE="$MOCK_DOCKER_STATE" PATH="$MOCK_BIN:$PATH" \
  bash "$TEST_DIR/rollback-program.sh" "$REMOTE_DIR" staging "$DEPLOYMENT_ID"

for relative_path in compose.yaml .env Caddyfile README.md media-runtime-versions.env; do
  cmp "$REMOTE_DIR/$relative_path" <(printf 'previous-%s\n' "$relative_path")
done
for env_name in staging production; do
  cmp "$REMOTE_DIR/env/process-audio-${env_name}.env" <(printf 'previous-secret-%s\n' "$env_name")
  [[ "$(stat -f %Lp "$REMOTE_DIR/env/process-audio-${env_name}.env" 2>/dev/null || stat -c %a "$REMOTE_DIR/env/process-audio-${env_name}.env")" == 600 ]]
  [[ "$(stat -f %u "$REMOTE_DIR/env/process-audio-${env_name}.env" 2>/dev/null || stat -c %u "$REMOTE_DIR/env/process-audio-${env_name}.env")" == "$(id -u)" ]]
done
cmp "$REMOTE_DIR/context/version" <(printf 'previous-context\n')
[[ "$(cat "$MOCK_DOCKER_STATE/services/ytdlp-pot-provider-staging")" == sha256:old-provider ]]
[[ "$(cat "$MOCK_DOCKER_STATE/services/caddy")" == sha256:old-caddy ]]
[[ ! -e "$REMOTE_DIR/.deploy-lock" ]]
[[ ! -e "$ROLLBACK_ROOT" ]]

echo "Process-audio rollback mock restored exact config, 0600 env files, provider, and Caddy"
