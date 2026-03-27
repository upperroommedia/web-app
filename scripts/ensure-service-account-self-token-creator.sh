#!/usr/bin/env bash
set -euo pipefail

project_id="${1:-}"
service_account_email="${2:-}"

if [[ -z "$project_id" || -z "$service_account_email" ]]; then
  echo "Usage: $0 <project_id> <service_account_email>" >&2
  exit 1
fi

member="serviceAccount:${service_account_email}"

gcloud iam service-accounts add-iam-policy-binding "$service_account_email" \
  --project "$project_id" \
  --member "$member" \
  --role "roles/iam.serviceAccountTokenCreator" >/dev/null

binding_present="$(
  gcloud iam service-accounts get-iam-policy "$service_account_email" \
    --project "$project_id" \
    --format=json |
    python3 -c "import json,sys; policy=json.load(sys.stdin); print(any(binding.get('role') == 'roles/iam.serviceAccountTokenCreator' and '${member}' in binding.get('members', []) for binding in policy.get('bindings', [])))"
)"

if [[ "$binding_present" != "True" ]]; then
  echo "Failed to verify self token creator binding for ${service_account_email}" >&2
  exit 1
fi

echo "Verified self token creator binding for ${service_account_email}"
