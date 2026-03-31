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

firebase_service_account_json="$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project "$GCP_PROJECT")"
browser_fallback_shared_secret="$(gcloud secrets versions access latest --secret=BROWSER_FALLBACK_SHARED_SECRET --project "$GCP_PROJECT")"

printf '%s' "$firebase_service_account_json" | \
  npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON --config wrangler.browser-fallback.jsonc --env "$DEPLOY_ENV"

printf '%s' "$browser_fallback_shared_secret" | \
  npx wrangler secret put BROWSER_FALLBACK_SHARED_SECRET --config wrangler.browser-fallback.jsonc --env "$DEPLOY_ENV"

npx wrangler deploy --config wrangler.browser-fallback.jsonc --env "$DEPLOY_ENV"
