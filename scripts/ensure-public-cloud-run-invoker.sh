#!/usr/bin/env bash
set -euo pipefail

project_id="${1:-}"
region="${2:-us-central1}"
service_name="${3:-ytdlp-pot-provider}"

if [[ -z "$project_id" ]]; then
  echo "Usage: $0 <project_id> [region] [service_name]" >&2
  exit 1
fi

gcloud run services add-iam-policy-binding "$service_name" \
  --project "$project_id" \
  --region "$region" \
  --member "allUsers" \
  --role "roles/run.invoker" >/dev/null

invoker_binding_present="$(
  gcloud run services get-iam-policy "$service_name" \
    --project "$project_id" \
    --region "$region" \
    --format=json |
    python3 -c 'import json,sys; policy=json.load(sys.stdin); print(any(binding.get("role") == "roles/run.invoker" and "allUsers" in binding.get("members", []) for binding in policy.get("bindings", [])))'
)"

if [[ "$invoker_binding_present" != "True" ]]; then
  echo "Failed to verify public invoker access for $service_name" >&2
  exit 1
fi

service_url="$(
  gcloud run services describe "$service_name" \
    --project "$project_id" \
    --region "$region" \
    --format='value(status.url)'
)"

test -n "$service_url"
curl -fsS "${service_url}/ping" >/dev/null
echo "Verified public invoker access for $service_name at ${service_url}/ping"
