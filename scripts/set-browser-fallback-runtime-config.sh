#!/usr/bin/env bash
set -euo pipefail

project_id="${1:-}"
database_url="${2:-}"
service_url="${3:-}"
enabled="${4:-false}"

if [[ -z "$project_id" || -z "$database_url" ]]; then
  echo "Usage: $0 <project_id> <database_url> [service_url] [enabled]" >&2
  exit 1
fi

updated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
payload="$(
  python3 - "$service_url" "$enabled" "$updated_at" <<'PY'
import json
import sys

service_url = sys.argv[1] or None
enabled = sys.argv[2].lower() == "true" and bool(service_url)
updated_at = sys.argv[3]

print(
    json.dumps(
        {
            "serviceUrl": service_url,
            "enabled": enabled,
            "updatedAt": updated_at,
        }
    )
)
PY
)"

access_token="$(gcloud auth print-access-token)"
target_url="${database_url%/}/runtimeConfig/youtube/browserFallback.json?print=silent"

curl --fail --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer ${access_token}" \
  -H "Content-Type: application/json" \
  --data "${payload}" \
  "${target_url}" >/dev/null

echo "Updated browser fallback runtime config at runtimeConfig/youtube/browserFallback"
