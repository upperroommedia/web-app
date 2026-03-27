#!/usr/bin/env bash
set -euo pipefail

project_id="${1:-}"
region="${2:-us-central1}"
network="${3:-default}"
subnet="${4:-default}"
router_name="${5:-browser-fallback-nat-router}"
nat_name="${6:-browser-fallback-nat}"
address_name="${7:-browser-fallback-nat-ip}"

if [[ -z "$project_id" ]]; then
  echo "Usage: $0 <project_id> [region] [network] [subnet] [router_name] [nat_name] [address_name]" >&2
  exit 1
fi

if ! gcloud compute addresses describe "$address_name" --project "$project_id" --region "$region" >/dev/null 2>&1; then
  gcloud compute addresses create "$address_name" --project "$project_id" --region "$region"
fi

if ! gcloud compute routers describe "$router_name" --project "$project_id" --region "$region" >/dev/null 2>&1; then
  gcloud compute routers create "$router_name" \
    --project "$project_id" \
    --region "$region" \
    --network "$network"
fi

if ! gcloud compute routers nats describe "$nat_name" --project "$project_id" --router "$router_name" --region "$region" >/dev/null 2>&1; then
  gcloud compute routers nats create "$nat_name" \
    --project "$project_id" \
    --router "$router_name" \
    --region "$region" \
    --nat-custom-subnet-ip-ranges "$subnet" \
    --nat-external-ip-pool "$address_name"
fi

reserved_ip="$(
  gcloud compute addresses describe "$address_name" \
    --project "$project_id" \
    --region "$region" \
    --format='value(address)'
)"

echo "Verified browser fallback static egress IP ${reserved_ip} via ${router_name}/${nat_name}"
