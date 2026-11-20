#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <output-dir> [release-commit]" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$1"

RELEASE_SHA="${2:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
if [[ ! "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || [[ "$(git -C "$ROOT_DIR" cat-file -t "$RELEASE_SHA")" != commit ]]; then
  echo "Expected an immutable release commit" >&2
  exit 1
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
# A worktree scan also captures ignored local credentials and build inputs. Read
# the exact release tree that the caller will record as this image's source.
git -C "$ROOT_DIR" -c tar.umask=0022 archive --format=tar "$RELEASE_SHA" -- \
  package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json patches \
  apps/process-audio packages/contracts packages/shared packages/orchestration | tar -xf - -C "$OUTPUT_DIR"

cat > "$OUTPUT_DIR/.dockerignore" <<'EOF'
/gha-creds-*.json
**/.git
**/.github
**/.next
**/.turbo
**/.cache
**/node_modules
**/dist
**/coverage
**/*.log
**/.DS_Store
EOF

echo "Prepared process-audio Hetzner context in $OUTPUT_DIR"
