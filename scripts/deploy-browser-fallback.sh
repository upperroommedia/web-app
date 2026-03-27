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
artifact_registry_repo="browser-fallback-repo"
image_name="browser-fallback"

case "$target_environment" in
  staging)
    project_id="urm-app-staging"
    service_name="browser-fallback-staging"
    firebase_project_id="urm-app-staging"
    firebase_storage_bucket="urm-app-staging.firebasestorage.app"
    firebase_database_url="https://urm-app-staging-default-rtdb.firebaseio.com/"
    ;;
  production|prod|main)
    project_id="urm-app"
    service_name="browser-fallback"
    firebase_project_id="urm-app"
    firebase_storage_bucket="urm-app.appspot.com"
    firebase_database_url="https://urm-app-default-rtdb.firebaseio.com/"
    ;;
  *)
    echo "Unknown environment: $target_environment" >&2
    exit 1
    ;;
esac

project_number="$(gcloud projects describe "$project_id" --format='value(projectNumber)')"
runtime_service_account="${project_number}-compute@developer.gserviceaccount.com"
network="${BROWSER_FALLBACK_NETWORK:-}"
subnet="${BROWSER_FALLBACK_SUBNET:-}"
router_name="${BROWSER_FALLBACK_NAT_ROUTER:-browser-fallback-nat-router}"
nat_name="${BROWSER_FALLBACK_NAT_NAME:-browser-fallback-nat}"
address_name="${BROWSER_FALLBACK_NAT_ADDRESS:-browser-fallback-nat-ip}"

if [[ -z "$network" && -z "$subnet" ]]; then
  if gcloud compute addresses describe "$address_name" --project "$project_id" --region "$region" >/dev/null 2>&1 \
    && gcloud compute routers describe "$router_name" --project "$project_id" --region "$region" >/dev/null 2>&1 \
    && gcloud compute routers nats describe "$nat_name" --project "$project_id" --router "$router_name" --region "$region" >/dev/null 2>&1; then
    network="default"
    subnet="default"
    echo "Detected browser fallback NAT infrastructure ${router_name}/${nat_name}; enabling direct VPC egress on ${network}/${subnet}."
  else
    echo "Static egress infrastructure not available; deploying browser fallback with default Cloud Run egress." >&2
  fi
fi

gcloud builds submit . \
  --project="$project_id" \
  --config="apps/browser-fallback/cloudbuild.yaml" \
  --ignore-file="apps/browser-fallback/.gcloudignore" \
  --substitutions="COMMIT_SHA=${commit_sha},_PROJECT_ID=${project_id},_REGION=${region},_AR_REPO=${artifact_registry_repo},_IMAGE_NAME=${image_name},_SERVICE_NAME=${service_name},_SERVICE_ACCOUNT=${runtime_service_account},_FIREBASE_PROJECT_ID=${firebase_project_id},_FIREBASE_STORAGE_BUCKET=${firebase_storage_bucket},_FIREBASE_DATABASE_URL=${firebase_database_url},_PROFILE_BUCKET=${firebase_storage_bucket},_NETWORK=${network},_SUBNET=${subnet}"
