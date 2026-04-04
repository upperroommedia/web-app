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
network="${PROCESS_AUDIO_NETWORK:-}"
subnet="${PROCESS_AUDIO_SUBNET:-}"

case "$target_environment" in
  staging)
    project_id="urm-app-staging"
    service_name="process-audio-staging"
    firebase_project_id="urm-app-staging"
    firebase_storage_bucket="urm-app-staging.firebasestorage.app"
    firebase_database_url="https://urm-app-staging-default-rtdb.firebaseio.com/"
    ;;
  production|prod|main)
    project_id="urm-app"
    service_name="process-audio"
    firebase_project_id="urm-app"
    firebase_storage_bucket="urm-app.appspot.com"
    firebase_database_url="https://urm-app-default-rtdb.firebaseio.com/"
    ;;
  *)
    echo "Unknown environment: $target_environment" >&2
    exit 1
    ;;
esac

if [[ -z "$network" && -z "$subnet" ]]; then
  process_audio_network_interface_json="$(
    gcloud run services describe "$service_name" \
      --project "$project_id" \
      --region "$region" \
      --format='value(spec.template.metadata.annotations.run.googleapis.com/network-interfaces)' 2>/dev/null || true
  )"

  if [[ -n "$process_audio_network_interface_json" ]]; then
    network="$(
      printf '%s' "$process_audio_network_interface_json" | python3 -c 'import json,sys; value=sys.stdin.read().strip(); data=json.loads(value) if value else []; print((data[0].get("network") if data else "") or "")'
    )"
    subnet="$(
      printf '%s' "$process_audio_network_interface_json" | python3 -c 'import json,sys; value=sys.stdin.read().strip(); data=json.loads(value) if value else []; print((data[0].get("subnetwork") if data else "") or "")'
    )"
  fi
fi

if [[ -z "$network" && -z "$subnet" ]]; then
  network="default"
  subnet="default"
  echo "Defaulting process-audio direct VPC egress to ${network}/${subnet}." >&2
fi

gcloud builds submit . \
  --project="$project_id" \
  --config="apps/process-audio/cloudbuild.yaml" \
  --ignore-file="apps/process-audio/.gcloudignore" \
  --substitutions="COMMIT_SHA=${commit_sha},_PROJECT_ID=${project_id},_REGION=${region},_AR_REPO=${artifact_registry_repo},_IMAGE_NAME=${image_name},_SERVICE_NAME=${service_name},_FIREBASE_PROJECT_ID=${firebase_project_id},_FIREBASE_STORAGE_BUCKET=${firebase_storage_bucket},_FIREBASE_DATABASE_URL=${firebase_database_url},_RUNTIME_ENV=${target_environment},_NETWORK=${network},_SUBNET=${subnet}"
