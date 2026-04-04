#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <staging|production> <gcp-project-id>" >&2
  exit 64
fi

DEPLOY_ENV="$1"
GCP_PROJECT="$2"
SECRET_NAME="${BROWSER_FALLBACK_FIREBASE_SERVICE_ACCOUNT_SECRET_NAME:-BROWSER_FALLBACK_FIREBASE_SERVICE_ACCOUNT_JSON}"

if [[ "$DEPLOY_ENV" != "staging" && "$DEPLOY_ENV" != "production" ]]; then
  echo "Unsupported Cloudflare browser-fallback env: $DEPLOY_ENV" >&2
  exit 64
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required for Cloudflare browser-fallback deploys." >&2
  exit 64
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "CLOUDFLARE_ACCOUNT_ID is required for Cloudflare browser-fallback deploys." >&2
  exit 64
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for Cloudflare browser-fallback deploys." >&2
  exit 64
fi

verify_cloudflare_containers_auth() {
  local url="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/containers/me"
  local response_file
  response_file="$(mktemp)"
  local http_status

  http_status="$(curl -sS -o "$response_file" -w '%{http_code}' \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "$url")"

  if [[ "$http_status" == "200" ]]; then
    rm -f "$response_file"
    return 0
  fi

  local response_body
  response_body="$(cat "$response_file")"
  rm -f "$response_file"

  if [[ "$http_status" == "401" || "$http_status" == "403" ]]; then
    cat >&2 <<EOF
Cloudflare Containers registry preflight failed for account ${CLOUDFLARE_ACCOUNT_ID}.
Endpoint: GET ${url}
HTTP status: ${http_status}
Response: ${response_body}

The Worker deploy path is configured correctly, but this account/token is not currently authorized to publish Cloudflare Containers images.
This is typically an account-level Containers entitlement/support issue rather than a repo or branch-routing issue.
EOF
    exit 65
  fi

  cat >&2 <<EOF
Cloudflare Containers registry preflight failed unexpectedly.
Endpoint: GET ${url}
HTTP status: ${http_status}
Response: ${response_body}
EOF
  exit 65
}

verify_cloudflare_containers_auth

process_audio_service="process-audio"
if [[ "$DEPLOY_ENV" == "staging" ]]; then
  process_audio_service="process-audio-staging"
fi

firebase_service_account_json="$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project "$GCP_PROJECT")"
browser_fallback_shared_secret="$(gcloud secrets versions access latest --secret=BROWSER_FALLBACK_SHARED_SECRET --project "$GCP_PROJECT")"
pot_provider_base_url="$(gcloud run services describe ytdlp-pot-provider --project "$GCP_PROJECT" --region us-central1 --format='value(status.url)' 2>/dev/null || true)"

if [[ -z "$pot_provider_base_url" ]]; then
  pot_provider_base_url="$(
    gcloud run services describe "$process_audio_service" --project "$GCP_PROJECT" --region us-central1 --format=json \
      | jq -r '.spec.template.spec.containers[0].env[]? | select(.name == "YTDLP_POT_PROVIDER_BASE_URL") | .value // empty' \
      | head -n 1
  )"
fi

printf '%s' "$firebase_service_account_json" | \
  npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON --config wrangler.browser-fallback.jsonc --env "$DEPLOY_ENV"

printf '%s' "$browser_fallback_shared_secret" | \
  npx wrangler secret put BROWSER_FALLBACK_SHARED_SECRET --config wrangler.browser-fallback.jsonc --env "$DEPLOY_ENV"

if [[ -n "$pot_provider_base_url" ]]; then
  printf '%s' "$pot_provider_base_url" | \
    npx wrangler secret put YTDLP_POT_PROVIDER_BASE_URL --config wrangler.browser-fallback.jsonc --env "$DEPLOY_ENV"
  echo "Configured YTDLP_POT_PROVIDER_BASE_URL for ${DEPLOY_ENV}: ${pot_provider_base_url}"
else
  echo "::warning::No YTDLP_POT_PROVIDER_BASE_URL could be resolved for ${DEPLOY_ENV}; cookie PO-token experiment will be skipped."
fi

npx wrangler deploy --config wrangler.browser-fallback.jsonc --env "$DEPLOY_ENV"
