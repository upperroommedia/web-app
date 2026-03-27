#!/usr/bin/env bash
set -euo pipefail

project_id="${1:-}"
region="${2:-us-central1}"
service_name="${3:-}"
service_account_email="${4:-}"

if [[ -z "$project_id" || -z "$service_name" || -z "$service_account_email" ]]; then
  echo "Usage: $0 <project_id> [region] <service_name> <service_account_email>" >&2
  exit 1
fi

member="serviceAccount:${service_account_email}"

for public_member in allUsers allAuthenticatedUsers; do
  gcloud run services remove-iam-policy-binding "$service_name" \
    --project "$project_id" \
    --region "$region" \
    --member "$public_member" \
    --role "roles/run.invoker" >/dev/null 2>&1 || true
done

gcloud run services add-iam-policy-binding "$service_name" \
  --project "$project_id" \
  --region "$region" \
  --member "$member" \
  --role "roles/run.invoker" >/dev/null

verification_json="$(
  gcloud run services get-iam-policy "$service_name" \
    --project "$project_id" \
    --region "$region" \
    --format=json
)"

binding_present="$(
  printf '%s' "$verification_json" |
    python3 -c "import json,sys; policy=json.load(sys.stdin); print(any(binding.get('role') == 'roles/run.invoker' and '${member}' in binding.get('members', []) for binding in policy.get('bindings', [])))"
)"

public_binding_present="$(
  printf '%s' "$verification_json" |
    python3 -c "import json,sys; policy=json.load(sys.stdin); print(any(binding.get('role') == 'roles/run.invoker' and any(member in {'allUsers', 'allAuthenticatedUsers'} for member in binding.get('members', [])) for binding in policy.get('bindings', [])))"
)"

if [[ "$binding_present" != "True" ]]; then
  echo "Failed to verify private invoker access for ${service_name}" >&2
  exit 1
fi

if [[ "$public_binding_present" == "True" ]]; then
  echo "Public invoker access is still enabled for ${service_name}" >&2
  exit 1
fi

echo "Verified private invoker access for ${service_name} from ${service_account_email}"
