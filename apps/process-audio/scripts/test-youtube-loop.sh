#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES="-f compose.yaml -f compose.youtube-test.yaml"

pnpm --dir ../browser-fallback build
PROCESS_AUDIO_HOST_PORT="${PROCESS_AUDIO_HOST_PORT:-18080}"
export PROCESS_AUDIO_HOST_PORT

docker compose $COMPOSE_FILES up -d --build browser-fallback ytdlp-pot-provider
trap 'docker compose $COMPOSE_FILES down --remove-orphans' EXIT INT TERM

attempt=0
until docker compose $COMPOSE_FILES exec -T browser-fallback curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "browser-fallback did not become healthy in time" >&2
    exit 1
  fi
  sleep 1
done

docker compose $COMPOSE_FILES up -d server
docker compose $COMPOSE_FILES exec -T server sh -lc 'pnpm build && node scripts/verify-youtube-local-loop.js'
