#!/usr/bin/env bash
set -euo pipefail

target_environment="${1:-}"
commit_sha="${2:-}"

if [[ -z "$target_environment" ]]; then
  echo "Usage: $0 <staging|production> [commit_sha]" >&2
  exit 1
fi

if [[ -z "$commit_sha" ]]; then
  commit_sha="$(git rev-parse HEAD)"
fi

region="us-central1"
artifact_registry_repo="process-audio-repo"
image_name="process-audio"
runtime_service_account="${RUNTIME_SERVICE_ACCOUNT:-}"

case "$target_environment" in
  staging)
    project_id="urm-app-staging"
    service_name="process-audio-staging"
    browser_fallback_service_name="browser-fallback-staging"
    firebase_project_id="urm-app-staging"
    firebase_storage_bucket="urm-app-staging.firebasestorage.app"
    firebase_database_url="https://urm-app-staging-default-rtdb.firebaseio.com/"
    ;;
  production|prod|main)
    project_id="urm-app"
    service_name="process-audio"
    browser_fallback_service_name="browser-fallback"
    firebase_project_id="urm-app"
    firebase_storage_bucket="urm-app.appspot.com"
    firebase_database_url="https://urm-app-default-rtdb.firebaseio.com/"
    ;;
  *)
    echo "Unknown environment: $target_environment" >&2
    exit 1
    ;;
esac

if [[ -z "$runtime_service_account" ]]; then
  runtime_service_account="$(
    gcloud run services describe "$service_name" \
      --project "$project_id" \
      --region "$region" \
      --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true
  )"
fi

if [[ -z "$runtime_service_account" ]]; then
  project_number="$(
    gcloud projects describe "$project_id" \
      --format='value(projectNumber)'
  )"
  runtime_service_account="${project_number}-compute@developer.gserviceaccount.com"
fi

browser_fallback_service_url="${BROWSER_FALLBACK_SERVICE_URL:-}"
if [[ -z "$browser_fallback_service_url" ]]; then
  browser_fallback_service_url="$(
    gcloud run services describe "$browser_fallback_service_name" \
      --project "$project_id" \
      --region "$region" \
      --format='value(status.url)' 2>/dev/null || true
  )"
fi

browser_fallback_endpoint=""
browser_fallback_enabled="false"
if [[ -n "$browser_fallback_service_url" ]]; then
  browser_fallback_endpoint="${browser_fallback_service_url}/fallback"
  browser_fallback_enabled="true"
fi

pot_provider_service_name="ytdlp-pot-provider"
pot_provider_url="${YTDLP_POT_PROVIDER_BASE_URL:-}"
deploy_pot_provider="${DEPLOY_POT_PROVIDER:-}"
browser_fallback_shared_secret_secret="${BROWSER_FALLBACK_SHARED_SECRET_SECRET:-}"

if [[ -z "$pot_provider_url" ]]; then
  pot_provider_url="$(
    gcloud run services describe "$pot_provider_service_name" \
      --project "$project_id" \
      --region "$region" \
      --format='value(status.url)' 2>/dev/null || true
  )"
fi

if [[ -z "$deploy_pot_provider" ]]; then
  if [[ -n "$pot_provider_url" ]]; then
    deploy_pot_provider="false"
  else
    deploy_pot_provider="true"
  fi
fi

if [[ -z "$browser_fallback_shared_secret_secret" ]]; then
  if gcloud secrets describe BROWSER_FALLBACK_SHARED_SECRET --project "$project_id" >/dev/null 2>&1; then
    browser_fallback_shared_secret_secret="BROWSER_FALLBACK_SHARED_SECRET"
  fi
fi

if [[ -n "$browser_fallback_shared_secret_secret" ]]; then
  echo "Ensuring ${runtime_service_account} can access secret ${browser_fallback_shared_secret_secret} in ${project_id}" >&2
  gcloud secrets add-iam-policy-binding "$browser_fallback_shared_secret_secret" \
    --project "$project_id" \
    --member "serviceAccount:${runtime_service_account}" \
    --role "roles/secretmanager.secretAccessor" >/dev/null
fi

gcloud builds submit . \
  --project="$project_id" \
  --config="apps/process-audio/cloudbuild.yaml" \
  --ignore-file="apps/process-audio/.gcloudignore" \
  --substitutions="COMMIT_SHA=${commit_sha},_PROJECT_ID=${project_id},_REGION=${region},_AR_REPO=${artifact_registry_repo},_IMAGE_NAME=${image_name},_SERVICE_NAME=${service_name},_FIREBASE_PROJECT_ID=${firebase_project_id},_FIREBASE_STORAGE_BUCKET=${firebase_storage_bucket},_FIREBASE_DATABASE_URL=${firebase_database_url},_YOUTUBE_BROWSER_FALLBACK_ENABLED=${browser_fallback_enabled},_YOUTUBE_BROWSER_FALLBACK_URL=${browser_fallback_endpoint},_DEPLOY_POT_PROVIDER=${deploy_pot_provider},_POT_PROVIDER_URL=${pot_provider_url},_BROWSER_FALLBACK_SHARED_SECRET_SECRET=${browser_fallback_shared_secret_secret}"
