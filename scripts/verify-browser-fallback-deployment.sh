#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 8 ]]; then
  echo "Usage: $0 <staging|production> <gcp-project> <database-url> <process-audio-service> <expected-firebase-project> <expected-browser-fallback-url> <expected-route-pattern> <expected-worker-name> [expected-final-browser-fallback-url]" >&2
  exit 64
fi

DEPLOY_ENV="$1"
GCP_PROJECT="$2"
DATABASE_URL="$3"
PROCESS_AUDIO_SERVICE="$4"
EXPECTED_FIREBASE_PROJECT="$5"
EXPECTED_BROWSER_FALLBACK_URL="${6%/}"
EXPECTED_ROUTE_PATTERN="$7"
EXPECTED_WORKER_NAME="$8"
EXPECTED_FINAL_BROWSER_FALLBACK_URL="${9:-}"
EXPECTED_FINAL_BROWSER_FALLBACK_URL="${EXPECTED_FINAL_BROWSER_FALLBACK_URL%/}"

EXPECTED_YOUTUBE_BROWSER_FALLBACK_URL="${EXPECTED_BROWSER_FALLBACK_URL}/fallback"
HEALTHCHECK_YOUTUBE_URL="${BROWSER_FALLBACK_HEALTHCHECK_YOUTUBE_URL:-https://youtu.be/dKaZ89SkVYY}"
CLOUDFLARE_ZONE_NAME="${CLOUDFLARE_ZONE_NAME:-upperroommedia.org}"

note() {
  echo "[browser-fallback-verify] $*"
}

fail() {
  echo "::error::$*"
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

get_json_field() {
  local name="$1"
  jq -r --arg name "$name" '
    .spec.template.spec.containers[0].env[]
    | select(.name == $name)
    | .value
  ' | head -n 1
}

get_url_origin() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import urlparse
parsed = urlparse(sys.argv[1])
print(f"{parsed.scheme}://{parsed.netloc}")
PY
}

maybe_get_identity_token() {
  local url="$1"
  if [[ "$url" != *".run.app"* ]]; then
    return 0
  fi
  local audience
  audience="$(get_url_origin "$url")"
  gcloud auth print-identity-token --audiences="$audience"
}

curl_browser_fallback() {
  local url="$1"
  shift

  local args=("$@")
  local headers=()
  if [[ -n "${BROWSER_FALLBACK_SHARED_SECRET:-}" ]]; then
    headers+=(-H "x-browser-fallback-secret: ${BROWSER_FALLBACK_SHARED_SECRET}")
  fi

  local identity_token=""
  if identity_token="$(maybe_get_identity_token "$url" 2>/dev/null)"; then
    if [[ -n "$identity_token" ]]; then
      headers+=(-H "Authorization: Bearer ${identity_token}")
    fi
  fi

  curl "${headers[@]}" "${args[@]}" "$url"
}

require_command curl
require_command jq
require_command gcloud

if [[ -z "$EXPECTED_BROWSER_FALLBACK_URL" ]]; then
  fail "Expected browser fallback URL is empty for ${DEPLOY_ENV}."
fi

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "$EXPECTED_ROUTE_PATTERN" && -n "$EXPECTED_WORKER_NAME" ]]; then
  note "Checking Cloudflare route attachment for ${EXPECTED_ROUTE_PATTERN}"
  zone_response="$(
    curl -fsSL \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --get \
      --data-urlencode "name=${CLOUDFLARE_ZONE_NAME}" \
      "https://api.cloudflare.com/client/v4/zones"
  )"

  zone_id="$(echo "$zone_response" | jq -r '.result[0].id // empty')"
  if [[ -z "$zone_id" ]]; then
    fail "Unable to resolve Cloudflare zone id for ${CLOUDFLARE_ZONE_NAME}."
  fi

  routes_response="$(
    curl -fsSL \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/${zone_id}/workers/routes"
  )"

  route_matches="$(
    echo "$routes_response" | jq -r \
      --arg pattern "$EXPECTED_ROUTE_PATTERN" \
      --arg script "$EXPECTED_WORKER_NAME" '
        [
          .result[]?
          | select(
              .pattern == $pattern
              and (
                (.script // "") == $script
                or (.script_name // "") == $script
                or (.service // "") == $script
              )
            )
        ] | length
      '
  )"

  if [[ "$route_matches" == "0" ]]; then
    fail "Cloudflare does not report an active route for ${EXPECTED_ROUTE_PATTERN} -> ${EXPECTED_WORKER_NAME}."
  fi
else
  note "Skipping Cloudflare route API verification because CLOUDFLARE_API_TOKEN is not set."
fi

note "Checking Firebase runtime config"
access_token="$(gcloud auth print-access-token)"
BROWSER_FALLBACK_SHARED_SECRET="$(gcloud secrets versions access latest --secret=BROWSER_FALLBACK_SHARED_SECRET --project "${GCP_PROJECT}")"
runtime_config_response="$(
  curl -fsSL \
    -H "Authorization: Bearer ${access_token}" \
    "${DATABASE_URL%/}/runtimeConfig/youtube/browserFallback.json"
)"

runtime_service_url="$(echo "$runtime_config_response" | jq -r '.serviceUrl // empty')"
runtime_enabled="$(echo "$runtime_config_response" | jq -r '.enabled // false')"
if [[ "$runtime_service_url" != "$EXPECTED_BROWSER_FALLBACK_URL" ]]; then
  fail "Runtime config serviceUrl mismatch for ${DEPLOY_ENV}. Expected ${EXPECTED_BROWSER_FALLBACK_URL}, got ${runtime_service_url:-<empty>}."
fi
if [[ "$runtime_enabled" != "true" ]]; then
  fail "Runtime config enabled flag is not true for ${DEPLOY_ENV}."
fi

note "Checking Cloud Run env wiring on ${PROCESS_AUDIO_SERVICE}"
service_json="$(gcloud run services describe "${PROCESS_AUDIO_SERVICE}" --project "${GCP_PROJECT}" --region us-central1 --format=json)"
firebase_project_value="$(echo "$service_json" | get_json_field FIREBASE_PROJECT_ID || true)"
database_url_value="$(echo "$service_json" | get_json_field FIREBASE_DATABASE_URL || true)"
browser_fallback_url_value="$(echo "$service_json" | get_json_field YOUTUBE_BROWSER_FALLBACK_URL || true)"

if [[ "$firebase_project_value" != "$EXPECTED_FIREBASE_PROJECT" ]]; then
  fail "Cloud Run FIREBASE_PROJECT_ID mismatch for ${DEPLOY_ENV}. Expected ${EXPECTED_FIREBASE_PROJECT}, got ${firebase_project_value:-<empty>}."
fi
if [[ "$database_url_value" != "$DATABASE_URL" ]]; then
  fail "Cloud Run FIREBASE_DATABASE_URL mismatch for ${DEPLOY_ENV}. Expected ${DATABASE_URL}, got ${database_url_value:-<empty>}."
fi
if [[ "$browser_fallback_url_value" != "$EXPECTED_YOUTUBE_BROWSER_FALLBACK_URL" ]]; then
  fail "Cloud Run YOUTUBE_BROWSER_FALLBACK_URL mismatch for ${DEPLOY_ENV}. Expected ${EXPECTED_YOUTUBE_BROWSER_FALLBACK_URL}, got ${browser_fallback_url_value:-<empty>}."
fi

note "Waiting for public session-status on ${EXPECTED_BROWSER_FALLBACK_URL}"
session_status_body=""
session_status_code=""
for attempt in {1..20}; do
  session_status_body="$(mktemp)"
  session_status_code="$(
    curl_browser_fallback \
      "${EXPECTED_BROWSER_FALLBACK_URL}/session-status" \
      -sS -o "$session_status_body" -w '%{http_code}' || true
  )"
  if [[ "$session_status_code" == "200" ]] && jq -e '.ok == true' "$session_status_body" >/dev/null 2>&1; then
    break
  fi
  rm -f "$session_status_body"
  session_status_body=""
  if [[ "$attempt" -lt 20 ]]; then
    sleep 15
  fi
done

if [[ -z "$session_status_body" || "$session_status_code" != "200" ]] || ! jq -e '.ok == true' "$session_status_body" >/dev/null 2>&1; then
  last_body="<missing>"
  if [[ -n "$session_status_body" && -f "$session_status_body" ]]; then
    last_body="$(cat "$session_status_body")"
  fi
  rm -f "$session_status_body"
  fail "Public session-status did not become healthy for ${DEPLOY_ENV}. HTTP ${session_status_code:-<none>} body: ${last_body}"
fi
rm -f "$session_status_body"

note "Resolving YouTube audio URL through the public browser-fallback endpoint"
resolve_payload="$(
  jq -cn \
    --arg youtubeUrl "$HEALTHCHECK_YOUTUBE_URL" \
    --arg env "$DEPLOY_ENV" \
    '{
      action: "resolve_audio_url",
      youtubeUrl: $youtubeUrl,
      requestContext: {
        operation: ("github-actions-" + $env + "-verify")
      }
    }'
)"

resolve_body="$(mktemp)"
resolve_code="$(
  curl_browser_fallback "${EXPECTED_BROWSER_FALLBACK_URL}/fallback" \
    -sS -o "$resolve_body" -w '%{http_code}' \
    -X POST \
    -H 'Content-Type: application/json' \
    --data "$resolve_payload" || true
)"

if [[ "$resolve_code" != "200" ]] || ! jq -e '.url | strings | length > 0' "$resolve_body" >/dev/null 2>&1; then
  resolve_response="$(cat "$resolve_body")"
  rm -f "$resolve_body"
  fail "Signed YouTube fallback verification failed for ${DEPLOY_ENV}. HTTP ${resolve_code:-<none>} body: ${resolve_response}"
fi
rm -f "$resolve_body"

if [[ -n "$EXPECTED_FINAL_BROWSER_FALLBACK_URL" ]]; then
  note "Checking final-resort browser-fallback endpoint at ${EXPECTED_FINAL_BROWSER_FALLBACK_URL}"
  final_status_body="$(mktemp)"
  final_status_code="$(
    curl_browser_fallback \
      "${EXPECTED_FINAL_BROWSER_FALLBACK_URL}/session-status" \
      -sS -o "$final_status_body" -w '%{http_code}' || true
  )"
  if [[ "$final_status_code" != "200" ]] || ! jq -e '.ok == true' "$final_status_body" >/dev/null 2>&1; then
    final_body="$(cat "$final_status_body")"
    rm -f "$final_status_body"
    fail "Final-resort session-status unhealthy for ${DEPLOY_ENV}. HTTP ${final_status_code:-<none>} body: ${final_body}"
  fi
  rm -f "$final_status_body"

  final_resolve_body="$(mktemp)"
  final_resolve_code="$(
    curl_browser_fallback "${EXPECTED_FINAL_BROWSER_FALLBACK_URL}/fallback" \
      -sS -o "$final_resolve_body" -w '%{http_code}' \
      -X POST \
      -H 'Content-Type: application/json' \
      --data "$resolve_payload" || true
  )"
  if [[ "$final_resolve_code" != "200" ]] || ! jq -e '.url | strings | length > 0' "$final_resolve_body" >/dev/null 2>&1; then
    final_resolve_response="$(cat "$final_resolve_body")"
    rm -f "$final_resolve_body"
    fail "Final-resort YouTube fallback verification failed for ${DEPLOY_ENV}. HTTP ${final_resolve_code:-<none>} body: ${final_resolve_response}"
  fi
  rm -f "$final_resolve_body"
fi

note "Checking queue health in RTDB"
queue_state="$(
  curl -fsSL \
    -H "Authorization: Bearer ${access_token}" \
    "${DATABASE_URL%/}/processAudioQueues/youtube/state.json"
)"

if [[ "$queue_state" != "null" ]]; then
  blocked_value="$(echo "$queue_state" | jq -r '.blocked // false')"
  deferred_count="$(echo "$queue_state" | jq -r '.deferredYouTubeTaskCount // 0')"
  if [[ "$blocked_value" == "true" ]]; then
    fail "Queue remains blocked for ${DEPLOY_ENV}: ${queue_state}"
  fi
  if [[ "$deferred_count" != "0" ]]; then
    fail "Queue still has deferred YouTube tasks for ${DEPLOY_ENV}: ${queue_state}"
  fi
fi

note "Verification passed for ${DEPLOY_ENV}"
