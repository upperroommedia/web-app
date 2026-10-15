#!/usr/bin/env bash
# A clean Linux checkout runs the same application validator used by GitHub Actions.
set -euo pipefail

root="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
cd "$root"
command -v docker >/dev/null
command -v python3 >/dev/null
if ! docker info >/dev/null 2>&1; then
  echo 'Start your local Docker engine, then rerun this command.' >&2
  exit 1
fi

# Source comes from Git, never from a host dependency tree, dotenv or credential directory.
check_clean_source() {
python3 - <<'PY'
import subprocess, sys
entries = subprocess.check_output(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all']).split(b'\0')
changed = [entry[3:].decode() for entry in entries if entry and not entry[3:].startswith(b'graphify-out/')]
if changed:
    print('Commit application/validation changes locally before running the clean snapshot. No push is needed.', file=sys.stderr)
    for path in changed[:15]: print('  '+path, file=sys.stderr)
    sys.exit(1)
PY
}
check_clean_source

head="$(git rev-parse HEAD)"
image_tag=urm-application-validation:local
mkdir -p output/validation/local
run_dir="$(mktemp -d "$root/output/validation/local/run-XXXXXXXX")"
mkdir -p "$run_dir/results"
name="urm-validation-$(date +%s)-$$"
volume="${name}-workspace"

# Build only the toolchain directory, with no application files or secrets as build context.
docker build --platform linux/amd64 --tag "$image_tag" ops/local-validation 2>&1 | tee "$run_dir/image-build.log"
image_id="$(docker image inspect "$image_tag" --format '{{.Id}}')"
check_clean_source
if [ "$(git rev-parse HEAD)" != "$head" ]; then
  echo 'Source commit changed during toolchain preparation; rerun against a frozen commit.' >&2
  exit 1
fi
python3 - "$run_dir" "$head" "$image_id" <<'PY'
import json, pathlib, shutil, subprocess, sys
out, head, image = sys.argv[1:]
free = shutil.disk_usage('.').free
if free < 15 * 1024**3:
    raise SystemExit('Full local validation requires at least 15 GiB free after building the toolchain image.')
record = {'commit': head, 'tree': subprocess.check_output(['git','rev-parse',head+'^{tree}'],text=True).strip(),
          'imageId': image, 'platform': 'linux/amd64', 'hostFreeBytesBeforeRun': free,
          'source': 'committed Git bundle; no host credentials, dotenv or dependencies mounted'}
pathlib.Path(out, 'source.json').write_text(json.dumps(record,indent=2)+'\n')
PY
git bundle create "$run_dir/source.bundle" HEAD
test "$(git bundle list-heads "$run_dir/source.bundle" HEAD | cut -d ' ' -f 1)" = "$head"
shasum -a 256 "$run_dir/source.bundle" > "$run_dir/source.bundle.sha256"
docker volume create --label dev.upperroom.validation=true "$volume" >/dev/null

cancelled=0
cleanup_failed=0
cancel() {
  cancelled=1
  docker stop --time 60 "$name" >/dev/null 2>&1 || cleanup_failed=1
}
trap cancel INT TERM

docker create --init --platform linux/amd64 --name "$name" \
  --label dev.upperroom.validation=true --shm-size=2g \
  --mount "type=volume,src=$volume,dst=/workspace" \
  --mount "type=bind,src=$run_dir/source.bundle,dst=/input/source.bundle,readonly" \
  --mount "type=bind,src=$run_dir/results,dst=/artifacts" \
  --env "URM_EXPECTED_COMMIT=$head" \
  --env URM_VALIDATION_SUMMARY_PATH=/artifacts/application-summary.json \
  --env CI=true \
  "$image_id" bash -ec '
    git init --quiet /workspace
    cd /workspace
    git fetch --quiet /input/source.bundle HEAD
    git checkout --quiet --detach FETCH_HEAD
    test "$(git rev-parse HEAD)" = "$URM_EXPECTED_COMMIT"
    exec node scripts/validate-application.mjs
  ' > "$run_dir/container.id"

if [ "$cancelled" -eq 0 ]; then docker start "$name" >/dev/null; fi
# Run clients in the background so Bash's wait is interruptible by SIGTERM.
# The container already exists, so cancellation can stop this exact owned resource.
(
  set +e
  docker logs --follow "$name" 2>&1 | tee "$run_dir/application.log"
  statuses=("${PIPESTATUS[@]}")
  printf '%s %s\n' "${statuses[0]}" "${statuses[1]}" > "$run_dir/log-status"
) &
logger_pid=$!
if [ "$cancelled" -eq 0 ]; then
  docker wait "$name" > "$run_dir/container-exit-code" &
  waiter_pid=$!
  set +e
  wait "$waiter_pid"
  waiter_status=$?
  while kill -0 "$waiter_pid" 2>/dev/null; do wait "$waiter_pid"; waiter_status=$?; done
  set -e
else
  waiter_status=0
  echo 130 > "$run_dir/container-exit-code"
fi
set +e
wait "$logger_pid"
logger_status=$?
while kill -0 "$logger_pid" 2>/dev/null; do wait "$logger_pid"; logger_status=$?; done
set -e
trap - INT TERM
result="$(cat "$run_dir/container-exit-code")"
if ! [[ "$result" =~ ^[0-9]+$ ]]; then result=1; fi
if [ "$waiter_status" -ne 0 ] || [ "$logger_status" -ne 0 ] || [ "$(cat "$run_dir/log-status")" != '0 0' ] || [ "$cleanup_failed" -ne 0 ]; then result=1; fi
if [ "$cancelled" -eq 1 ] && [ "$result" -eq 0 ]; then result=130; fi

# Keep browser diagnostics even when the validator fails; no host dev session is involved.
docker cp "$name:/workspace/apps/web/test-results" "$run_dir/browser-results" >/dev/null 2>&1 || true
if [ "$result" -eq 0 ]; then
  # A zero container exit alone is insufficient proof: require every stage in the shared summary.
  python3 - "$run_dir/results/application-summary.json" "$head" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
assert s.get('passed') is True, 'Validator summary did not attest full success'
assert s.get('source', {}).get('commit') == sys.argv[2], 'Validated commit differs from frozen source'
assert len(s.get('stages', [])) == 19, 'Full validation must account for all 19 stages'
assert all(stage.get('status') == 'passed' and stage.get('commands') and all(command.get('code') == 0 and not command.get('signal') and not command.get('error') for command in stage['commands']) for stage in s['stages']), 'A stage or command did not pass'
PY
  docker rm "$name" >/dev/null
  docker volume rm "$volume" >/dev/null
  echo "Full local validation passed. Evidence: $run_dir"
else
  echo "Local validation failed (exit $result). Evidence: $run_dir" >&2
  echo "Retained container $name and workspace volume $volume for diagnosis." >&2
fi
exit "$result"
