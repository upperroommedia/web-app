#!/usr/bin/env bash
set -eEuo pipefail
trap 'printf "Qualifier stopped at line %s\n" "$LINENO" >&2' ERR
cd /opt/upperroom/process-audio-hetzner
root="$PWD"
if [[ "$#" != 3 ]]; then
    echo 'Usage: qualify-process-audio-hetzner-shadow.sh <context-sha256> <source-revision> <local-image-id> < firebase-database-emulator-v4.11.2.jar' >&2
    exit 64
fi
context="$1"
revision="$2"
image="$3"
[[ "$context" =~ ^[a-f0-9]{64}$ && "$revision" =~ ^[a-f0-9]{40}$ && "$image" =~ ^sha256:[a-f0-9]{64}$ ]]
prefix="urm-audio-shadow-${context:0:12}"
scratch_root="$root/state/staging"
candidate_root="$root/state/deploy-candidates"
candidate_dir="$candidate_root/$context"
candidate_tag="upperroom/process-audio-candidate:$context"
lock_dir="$root/.deploy-lock"
owner="shadow-${revision:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
test ! -e "$candidate_dir" && test ! -L "$candidate_dir"
if docker image inspect "$candidate_tag" >/dev/null 2>&1; then exit 2; fi
network="$prefix"
app="$prefix-app"
provider="$prefix-pot"
db="$prefix-db"
provider_image=sha256:cc43872a20320758e0b2ae1e25c0c314d53d07ed703bd32d35e14a5745babd0d
test "$(docker inspect --format '{{.Image}}' "$(docker compose ps -q ytdlp-pot-provider-staging)")" = "$provider_image"
java_image=eclipse-temurin@sha256:d77e090ae1f6970c047b443c6f0a6c1358b0426d44432bb5a7753408cd43de0d
jar_hash=b70d99344caf17c98b6f910fa8f6edf32a7c016cb1035e8915f70d38901eb97f
snapshot() { docker ps --no-trunc --format '{{.Names}} {{.ID}} {{.Image}}' | grep -v "^$prefix-" | sort; }
before="$(snapshot)"
test ! -e .deploy-lock && test ! -L .deploy-lock
test "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)" -ge 1800000
test "$(df -Pk /var/lib/docker | awk 'NR == 2 {print $4}')" -gt 4194304
test "$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}}' "$image")" = "$image linux/amd64"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "io.upperroom.qualification.context-sha256"}}' "$image")" = "$revision $context"
test "$(docker image inspect --format '{{.Architecture}}' "$java_image")" = amd64
test "$(docker inspect --format '{{.State.Running}}' "$(docker compose ps -q process-audio-staging)")" = true
test "$(docker inspect --format '{{.State.Running}}' "$(docker compose ps -q process-audio-production)")" = true
test -z "$(docker ps -aq --filter "name=^/$prefix-")"
if docker network inspect "$network" >/dev/null 2>&1; then exit 2; fi
config=env/process-audio-staging.env
config_value() {
    test "$(grep -c "^$1=" "$config")" = 1
    sed -n "s/^$1=//p" "$config"
}
export PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL="$(config_value PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL)"
export PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL="$(config_value PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL)"
[[ "$PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL" =~ ^https://(www\.)?(youtube\.com|youtu\.be)/[^[:space:]]+$ ]]
[[ "$PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL" =~ ^https://(www\.)?(youtube\.com|youtu\.be)/[^[:space:]]+$ ]]
test "$PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL" != "$PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL"
mkdir "$lock_dir"
printf '%s\n' "$owner" > "$lock_dir/deployment-id"
printf '%s\n' 'staging-shadow' > "$lock_dir/target-env"
printf '%s\n' "$(( $(date +%s) + 3600 ))" > "$lock_dir/lease-expires-at"
dir="$(mktemp -d "$scratch_root/audio-qualification.XXXXXXXX")"
declare -a owned_containers=()
owned_network=false
cleanup() {
    local status="$?" id
    trap - EXIT
    if (( status != 0 )) && [[ -n "${app_id:-}" ]]; then
        docker inspect --format 'Lab app status={{.State.Status}} exit={{.State.ExitCode}}' "$app_id" >&2 || true
    fi
    for id in "${owned_containers[@]}"; do docker rm -f "$id" >/dev/null || status=1; done
    if [[ "$owned_network" == true ]]; then docker network rm "$network" >/dev/null || status=1; fi
    if [[ "$(snapshot)" != "$before" || "$(cat "$lock_dir/deployment-id")" != "$owner" ]]; then
        echo 'Serving inventory or shared deployment state changed during qualification' >&2
        status=1
    fi
    if (( status == 0 )); then
        publish_candidate || status=1
    fi
    rm -f -- "$dir/database.jar" "$dir/application-report.json" "$dir/verified-report.json"
    rmdir -- "$dir" || status=1
    if [[ "$(cat "$lock_dir/deployment-id")" == "$owner" ]]; then
        rm -f -- "$lock_dir/deployment-id" "$lock_dir/target-env" "$lock_dir/lease-expires-at"
        rmdir -- "$lock_dir" || status=1
    fi
    printf 'Qualification resources closed; exit=%s\n' "$status"
    exit "$status"
}
publish_candidate() {
    # The running candidate was checked by ID, the app reports were persisted in an isolated
    # emulator, and all serving instances survived unchanged. Only now make the image promotable.
    test -s "$dir/verified-report.json" || return 1
    mkdir -p "$candidate_root" || return 1
    test ! -e "$candidate_dir" && test ! -L "$candidate_dir" || return 1
    if docker image inspect "$candidate_tag" >/dev/null 2>&1; then return 1; fi
    local pending
    pending="$(mktemp -d "$candidate_root/.shadow-$context.XXXXXXXX")" || return 1
    cp "$dir/verified-report.json" "$pending/shadow-qualification.json" || return 1
    printf '%s\n' "$context" > "$pending/context-sha256" || return 1
    printf '%s\n' "$revision" > "$pending/source-release-sha" || return 1
    printf '%s\n' "$image" > "$pending/image-id" || return 1
    printf '%s\n' "$candidate_tag" > "$pending/image-ref" || return 1
    printf '%s\n' "$owner" > "$pending/validated-by-deployment" || return 1
    printf '%s\n' youtube > "$pending/validated-smoke-profile" || return 1
    date -u +%FT%TZ > "$pending/validated-at" || return 1
    docker image tag "$image" "$candidate_tag" || return 1
    test "$(docker image inspect --format '{{.Id}}' "$candidate_tag")" = "$image" || return 1
    : > "$pending/validated" || return 1
    mv -T "$pending" "$candidate_dir" || return 1
    printf 'Qualified deployment context %s at image %s\n' "$context" "$image"
}
trap cleanup EXIT

cat > "$dir/database.jar"
test "$(sha256sum "$dir/database.jar" | awk '{print $1}')" = "$jar_hash"
chmod 0444 "$dir/database.jar"
docker network create --driver bridge "$network" >/dev/null
owned_network=true

db_id="$(docker create --pull=never --name "$db" --network "$network" --network-alias emulated-db \
    --restart no --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 96 --cpus .5 --memory 400m \
    --mount "type=bind,src=$dir/database.jar,dst=/lab-database.jar,readonly" \
    --entrypoint /opt/java/openjdk/bin/java "$java_image" \
    -XX:ActiveProcessorCount=1 -Xms32m -Xmx192m -jar /lab-database.jar --host 0.0.0.0 --port 9000 --single_project_mode Error)"
owned_containers+=("$db_id")
provider_id="$(docker create --pull=never --name "$provider" --network "$network" --network-alias private-pot \
    --restart no --pids-limit 96 --cpus .5 --memory 256m "$provider_image")"
owned_containers+=("$provider_id")
docker start "$db_id" "$provider_id" >/dev/null

app_id="$(docker create --pull=never --init --name "$app" --network "$network" --restart no \
    --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 96 --cpus 1 --memory 768m \
    --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700 --user 1000:1000 \
    --mount "type=bind,src=$root/state/shared-browser-profile,dst=/workspace/shared-browser-profile,readonly" \
    -e HOME=/tmp -e NODE_ENV=production -e LOG_LEVEL=warn \
    -e FIREBASE_PROJECT_ID=demo-pr277-qualification -e GOOGLE_CLOUD_PROJECT=demo-pr277-qualification -e GCLOUD_PROJECT=demo-pr277-qualification \
    -e FIREBASE_STORAGE_BUCKET=demo-pr277-qualification.appspot.com -e FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9 \
    -e FIREBASE_DATABASE_EMULATOR_HOST=emulated-db:9000 -e 'FIREBASE_DATABASE_URL=http://emulated-db:9000?ns=demo-pr277-qualification-default-rtdb' \
    -e FIRESTORE_EMULATOR_HOST=127.0.0.1:9 -e FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9 -e CLOUD_TASKS_EMULATOR_HOST=127.0.0.1:9 \
    -e PROCESS_AUDIO_RUNTIME_PROFILE=hetzner -e PROCESS_AUDIO_RUNTIME_HOST=hetzner -e PROCESS_AUDIO_RUNTIME_ENV=staging \
    -e PROCESS_AUDIO_RECOVER_ORPHANED_STATE_ON_STARTUP=false \
    -e PROCESS_AUDIO_BROWSER_PROFILE_DIR=/workspace/shared-browser-profile/.config/google-chrome \
    -e PROCESS_AUDIO_BROWSER_PROFILE_BROWSER=chrome -e PROCESS_AUDIO_IN_PROCESS_BROWSER_FALLBACK_ENABLED=false \
    -e YOUTUBE_BROWSER_FALLBACK_ENABLED=false -e YTDLP_JS_RUNTIME=deno -e YTDLP_POT_PROVIDER_BASE_URL=http://private-pot:4416 \
    -e PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_TIMEOUT_MS=45000 -e PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_TIMEOUT_MS=45000 \
    -e PROCESS_AUDIO_YOUTUBE_GUEST_CANARY_URL -e PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL "$image")"
owned_containers+=("$app_id")
test "$(docker inspect --format '{{.Image}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}}' "$app_id")" = "$image true $network 0"
test "$(docker inspect --format '{{range .Mounts}}{{.RW}} {{end}}' "$app_id")" = 'false '
test "$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$app_id" | awk -F= '$1 ~ /^(GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_SERVICE_ACCOUNT_JSON|PROCESS_AUDIO_BROWSER_REFRESH_CONTROL_DIR|PROCESS_AUDIO_BROWSER_POT_CONTROL_DIR|SENTRY_DSN)$/ {n++} END {print n+0}')" = 0
printf 'Unrouted qualification image %s; app %s\n' "$image" "$app_id"
for i in $(seq 1 35); do
    if docker exec "$provider_id" node -e 'Promise.all([fetch("http://127.0.0.1:4416/ping").then(r=>r.json()).then(x=>{if(x.version!=="1.3.2")throw Error()}),fetch("http://emulated-db:9000/.json?ns=demo-pr277-qualification-default-rtdb&auth=owner").then(r=>{if(!r.ok)throw Error()})]).catch(()=>process.exit(1))' >/dev/null 2>&1; then break; fi
    if [[ "$i" == 35 ]]; then echo 'Qualification dependencies did not start'; exit 1; fi
    sleep 1
done
docker start "$app_id" >/dev/null
for i in $(seq 1 55); do
    if docker exec "$app_id" curl -fsS --connect-timeout 1 --max-time 3 http://127.0.0.1:8080/readyz > "$dir/application-report.json" 2>/dev/null; then break; fi
    if [[ "$i" == 55 ]]; then
        docker exec "$app_id" curl -sS --connect-timeout 1 --max-time 5 http://127.0.0.1:8080/readyz > "$dir/application-report.json" 2>/dev/null || true
        break
    fi
    sleep 2
done
test "$(docker exec "$app_id" yt-dlp --version)" = 2026.11.23
python3 - "$dir/application-report.json" "$dir/verified-report.json" "$image" "$revision" "$context" <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import json,sys
report=json.loads(Path(sys.argv[1]).read_bytes())
provider=report.get("provider") or {}
assert provider.get("configured") and provider.get("discovered") and provider.get("reachable") and provider.get("version")=="1.3.2", "provider readiness failed"
caps=report.get("capabilities") or {}
now=datetime.now(timezone.utc)
reports={}
for scope in ("guest","authenticated"):
    canary=caps.get(scope,{}).get("mediaByteCanary") or {}
    reports[scope] = {k:canary.get(k) for k in ("checkedAt","succeeded","bytesDownloaded","failureClass")}
    print(json.dumps({"scope":scope,**reports[scope]}))
    age=(now-datetime.fromisoformat(canary["checkedAt"].replace("Z","+00:00"))).total_seconds()
    assert -5 <= age < 180, "Canary was not actually persisted by this lab"
    n=canary.get("bytesDownloaded")
    assert type(n) is int and n >= 0
    success=canary.get("succeeded") is True and n > 0 and canary.get("failureClass") is None
    assert success or (scope=="guest" and n==0 and canary.get("failureClass") in ("public_path_bot_blocked","account_required_content"))
readiness=report.get("serviceReadiness") or {}
assert readiness.get("ready") is True, readiness.get("reasonCodes")
Path(sys.argv[2]).write_text(json.dumps({
    "schemaVersion":1, "kind":"isolated-staging-application-smoke", "imageId":sys.argv[3],
    "sourceRevision":sys.argv[4], "contextSHA256":sys.argv[5], "providerVersion":"1.3.2",
    "canaries":reports, "serviceReady":True, "observedAt":now.isoformat(),
}, sort_keys=True)+"\n")
print("Application readiness and persisted canary reports passed")
PY
