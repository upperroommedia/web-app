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

# Explicit verified caller identities and audiences are deployment inputs; never infer
# trust from a task header, a Google user account, or a public service URL.
: "${PROCESS_AUDIO_ALLOWED_CALLER_EMAILS:?Set a JSON array of the verified queue service-account emails}"
: "${PROCESS_AUDIO_OIDC_AUDIENCES:?Set a JSON array of exact media service audiences}"
python3 - <<'CHECK_NATIVE_AUTH'
import json, os, re
emails=json.loads(os.environ['PROCESS_AUDIO_ALLOWED_CALLER_EMAILS'])
audiences=json.loads(os.environ['PROCESS_AUDIO_OIDC_AUDIENCES'])
if not isinstance(emails,list) or not emails or any(not isinstance(v,str) or not re.fullmatch(r'[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com',v) for v in emails):
    raise SystemExit('Expected an explicit nonempty service-account email allowlist')
if not isinstance(audiences,list) or not audiences or any(not isinstance(v,str) or not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?(?:/[a-zA-Z0-9/_-]*)?',v) for v in audiences):
    raise SystemExit('Expected exact HTTPS service audiences')
CHECK_NATIVE_AUTH

native_task_service_account="$(gcloud run services describe "$service_name" --project "$project_id" --region "$region" --format='value(spec.template.spec.serviceAccountName)')"
: "${native_task_service_account:?Observe the existing Cloud Run runtime service-account identity before deploying}"
PROCESS_AUDIO_TASK_SERVICE_ACCOUNT_EMAIL="$native_task_service_account" python3 - <<'CHECK_NATIVE_RUNTIME_CALLER'
import json,os
if os.environ['PROCESS_AUDIO_TASK_SERVICE_ACCOUNT_EMAIL'] not in json.loads(os.environ['PROCESS_AUDIO_ALLOWED_CALLER_EMAILS']):
    raise SystemExit('The observed native runtime identity must be an explicit allowed task caller')
CHECK_NATIVE_RUNTIME_CALLER

gcloud builds submit . \
  --project="$project_id" \
  --config="apps/process-audio/cloudbuild.yaml" \
  --ignore-file="apps/process-audio/.gcloudignore" \
  --substitutions="^|^COMMIT_SHA=${commit_sha}|_PROJECT_ID=${project_id}|_REGION=${region}|_AR_REPO=${artifact_registry_repo}|_IMAGE_NAME=${image_name}|_SERVICE_NAME=${service_name}|_FIREBASE_PROJECT_ID=${firebase_project_id}|_FIREBASE_STORAGE_BUCKET=${firebase_storage_bucket}|_FIREBASE_DATABASE_URL=${firebase_database_url}|_RUNTIME_ENV=${target_environment}|_PROCESS_AUDIO_ALLOWED_CALLER_EMAILS=${PROCESS_AUDIO_ALLOWED_CALLER_EMAILS}|_PROCESS_AUDIO_OIDC_AUDIENCES=${PROCESS_AUDIO_OIDC_AUDIENCES}|_PROCESS_AUDIO_TASK_SERVICE_ACCOUNT_EMAIL=${native_task_service_account}"
