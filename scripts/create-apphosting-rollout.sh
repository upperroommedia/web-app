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

case "$target_environment" in
  staging)
    project_id="urm-app-staging"
    backend_id="web-staging"
    ;;
  production|prod|main)
    project_id="urm-app"
    backend_id="web-prod"
    ;;
  *)
    echo "Unknown environment: $target_environment" >&2
    exit 1
    ;;
esac

echo "Creating App Hosting rollout for ${backend_id} on ${project_id} at commit ${commit_sha}"
npx -y firebase-tools@latest apphosting:rollouts:create "${backend_id}" \
  --project "${project_id}" \
  --git-commit "${commit_sha}" \
  --force \
  --non-interactive
