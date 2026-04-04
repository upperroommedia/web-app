#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <output-dir>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$1"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/apps" "$OUTPUT_DIR/packages"

cp "$ROOT_DIR/.npmrc" "$OUTPUT_DIR/.npmrc"
cp "$ROOT_DIR/package.json" "$OUTPUT_DIR/package.json"
cp "$ROOT_DIR/pnpm-lock.yaml" "$OUTPUT_DIR/pnpm-lock.yaml"
cp "$ROOT_DIR/pnpm-workspace.yaml" "$OUTPUT_DIR/pnpm-workspace.yaml"
cp "$ROOT_DIR/turbo.json" "$OUTPUT_DIR/turbo.json"

rsync -a --delete "$ROOT_DIR/apps/process-audio/" "$OUTPUT_DIR/apps/process-audio/"
rsync -a --delete "$ROOT_DIR/packages/contracts/" "$OUTPUT_DIR/packages/contracts/"
rsync -a --delete "$ROOT_DIR/packages/shared/" "$OUTPUT_DIR/packages/shared/"

cat > "$OUTPUT_DIR/.dockerignore" <<'EOF'
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
