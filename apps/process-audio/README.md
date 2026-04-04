# Process Audio

Shared `process-audio` runtime with two deployment profiles:

- Cloud Run: storage-backed trim/transcode only
- Hetzner: YouTube-capable worker with `yt-dlp`, browser session access, and browser fallback support

## YouTube Extraction Model

The YouTube path now follows a strict access order:

1. `public_provider`
   Uses `yt-dlp` with the bgutil PO-token provider and no cookies.
2. `cookie_provider`
   Uses `yt-dlp --cookies-from-browser` against the shared host Chrome profile on Hetzner.
3. `browser_fallback`
   Final authority when the direct extractor path is challenged.

This is intentional. Cloud Run is no longer part of the YouTube extraction path. File-backed audio stays on Cloud Run, while YouTube extraction stays on Hetzner.

## What Changed

- Request-scoped YouTube access decisions are cached so one sermon request does not repeatedly probe YouTube after a known failure.
- Hetzner no longer relies on RTDB cookie blobs; the shared host Chrome profile is the YouTube session source of truth.
- Hetzner now reports runtime failures to Sentry project `process-audio-hetzner`.
- Operational alerts now classify YouTube failures into:
  - `public_ip_or_reputation_block`
  - `cookie_session_stale`
  - `account_required_no_valid_session`
  - `browser_fallback_failed`
  - `provider_unhealthy`
- The service exposes `GET /healthz`.
- A local Docker validation loop now gates changes before deployment.

## Prerequisites

- Docker
- `pnpm`
- Google Cloud SDK
- A GCP project with the required service accounts and secrets

## Environment Variables

Core runtime:

- `GOOGLE_APPLICATION_CREDENTIALS`
- `PROCESS_AUDIO_BUCKET`
- `RUNTIME_ALERT_RECIPIENTS` or the Secret Manager binding used by deploy
- `PROCESS_AUDIO_RUNTIME_PROFILE=cloudrun|hetzner`
- `SENTRY_DSN`
- `SENTRY_ENVIRONMENT`
- `SENTRY_RELEASE`
- `SENTRY_TRACES_SAMPLE_RATE`

YouTube extraction, Hetzner profile only:

- `YTDLP_POT_PROVIDER_BASE_URL`
- `YOUTUBE_BROWSER_FALLBACK_URL`
- `YOUTUBE_BROWSER_FALLBACK_ENABLED`
- `YOUTUBE_BROWSER_FALLBACK_TIMEOUT_MS`
- `BROWSER_FALLBACK_SHARED_SECRET` optional shared secret for non-Google fallback hosts
- `BROWSER_FALLBACK_AUTH_MODE=auto|id_token|shared_secret|none`
- `YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS=true` on Hetzner
- `YTDLP_CONCURRENT_FRAGMENTS=1`
- `YTDLP_COOKIE_HEALTHCHECK_ENABLED=true`
- `YOUTUBE_RETRY_DELAY_MS=1500`
- `YOUTUBE_PUBLIC_PROVIDER_MAX_ATTEMPTS=1`
- `YOUTUBE_COOKIE_PROVIDER_MAX_ATTEMPTS=1`
- `YOUTUBE_COOKIE_CIRCUIT_BREAKER_MINUTES=30`
- `YTDLP_SLEEP_REQUESTS_SECONDS=2`
- `YTDLP_SLEEP_INTERVAL_SECONDS=1`
- `YTDLP_MAX_SLEEP_INTERVAL_SECONDS=3`
- `YTDLP_JS_RUNTIME=deno`

## Local Development

From the monorepo root, build the image:

```bash
docker build --build-arg PROCESS_AUDIO_RUNTIME_PROFILE=hetzner --file apps/process-audio/Dockerfile --tag process-audio .
```

Run the container against real Firebase:

```bash
docker run \
  -e GOOGLE_APPLICATION_CREDENTIALS="/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json" \
  -v /Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json:/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json \
  --env-file .env \
  -p 8080:8080 \
  process-audio
```

Run the container against the Firebase emulator:

```bash
docker run \
  -e NODE_ENV=development \
  -e GOOGLE_APPLICATION_CREDENTIALS="/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json" \
  -e FIREBASE_EMULATOR_HOST="host.docker.internal" \
  -e FIRESTORE_EMULATOR_PORT="8081" \
  -e FIREBASE_AUTH_EMULATOR_PORT="9099" \
  -e FIREBASE_STORAGE_EMULATOR_PORT="9199" \
  -e FIREBASE_DATABASE_EMULATOR_PORT="9000" \
  -v /Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json:/Users/yasaad/Downloads/urm-app-firebase-adminsdk-p39zx-aec4d133ad.json \
  --env-file .env \
  -p 8080:8080 \
  process-audio
```

## Local Docker Validation Loop

The repo now contains a reproducible YouTube validation harness that mirrors the production topology:

- `server`
- `ytdlp-pot-provider`
- `browser-fallback`
- deterministic fake `yt-dlp` scenarios for negative-path tests

From the monorepo root, run the loop:

```bash
pnpm --dir apps/process-audio verify:youtube:loop
```

Equivalent direct command:

```bash
bash scripts/test-youtube-loop.sh
```

The loop validates:

- public-path success without cookies
- stale-cookie classification and circuit-breaker behavior
- browser fallback for direct URL resolution
- browser fallback for section downloads

Artifacts are written to `.tmp/youtube-loop/`.

Deployment rule:

- Do not deploy YouTube extraction changes until the local loop passes.

## Sentry

Hetzner `process-audio` sends runtime exceptions to Sentry project `process-audio-hetzner` in org `upper-room-media`.

Implementation references:

- [src/instrument.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/process-audio/src/instrument.ts)
- [src/index.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/process-audio/src/index.ts)

Current behavior:

- Sentry is initialized before Express boot
- handled request failures are captured explicitly before sermon error state is written
- `GET /healthz` reports:
  - `sentryEnabled`
  - `sentryEnvironment`
  - `sentryRelease`

Hetzner deploys inject Sentry from GCP Secret Manager:

- secret name: `PROCESS_AUDIO_SENTRY_DSN`
- staging project: `urm-app-staging`
- production project: `urm-app`

Quick verification after deploy:

```bash
curl https://yt-worker-staging.upperroommedia.org/healthz | jq '.sentryEnabled, .sentryEnvironment, .sentryRelease'
curl https://yt-worker.upperroommedia.org/healthz | jq '.sentryEnabled, .sentryEnvironment, .sentryRelease'
```

Container-level verification:

```bash
ssh root@<hetzner-ip> "docker exec process-audio-hetzner-process-audio-staging-1 /bin/sh -lc 'env | grep -E \"^SENTRY_|^PROCESS_AUDIO_RUNTIME_(ENV|HOST|PROFILE)=\" | sort'"
ssh root@<hetzner-ip> "docker exec process-audio-hetzner-process-audio-production-1 /bin/sh -lc 'env | grep -E \"^SENTRY_|^PROCESS_AUDIO_RUNTIME_(ENV|HOST|PROFILE)=\" | sort'"
```

If you send a synthetic smoke event from a live container, ignore the resulting issue in Sentry immediately so it does not create operational noise.

## Local Test Topology

`compose.youtube-test.yaml` adds:

- `browser-fallback`
  - mock service implementing `POST /fallback`
  - `GET /healthz`
  - `GET /session-status`
- `ytdlp-pot-provider`
  - bgutil provider container
- `server`
  - same app container with YouTube env vars wired for the local loop

The validation harness uses deterministic scenarios for:

- public success
- public bot challenge
- stale cookie failure
- provider unavailable
- browser fallback recovery

Keep at least one live smoke test in staging, but use the deterministic local loop as the default regression gate.

## Deploying to Google Cloud Run

Runtime failure alert recipients are injected from the Secret Manager secret `RUNTIME_ALERT_RECIPIENTS` during Cloud Run deploys. The app also supports `PROCESS_AUDIO_ALERT_RECIPIENTS`, `RUNTIME_ALERT_RECIPIENTS`, or `RUNTIME_ALERT_EMAILS`, but deploy should bind `RUNTIME_ALERT_RECIPIENTS`.

The current production split is:

- Cloud Run `process-audio`: storage-backed processing only
- Hetzner `yt-worker`: YouTube extraction and transcode orchestration
- optional but recommended browser fallback worker on a stateful host with:
  - persistent Chromium profile storage
  - a dedicated YouTube service account
  - stable outbound IP

## Browser Fallback Contract

The browser worker endpoint referenced by `YOUTUBE_BROWSER_FALLBACK_URL` must accept JSON `POST` requests.

Supported actions:

- `action=resolve_audio_url`
  - request body: `youtubeUrl`
  - response body: `{ "url": "...", "format": "m4a", "duration": 123 }`
- `action=download_section`
  - request body: `youtubeUrl`, `startTime`, `duration`
  - response body: `{ "downloadUrl": "...", "ext": "m4a" }`

Operational endpoints expected on the worker:

- `GET /healthz`
- `GET /session-status`

For non-Google fallback hosts such as Cloudflare, `process-audio` can authenticate with the optional `BROWSER_FALLBACK_SHARED_SECRET` header instead of Google ID tokens.

## Cookie Rotation Workflow

Hetzner uses the shared host Chrome profile rather than RTDB cookie blobs.

Use the operator guide for the current workflow:

- [ops/process-audio-hetzner/README.md](/Users/yasaad/Projects/upper-room-media/web-app/ops/process-audio-hetzner/README.md)

Current rule:

- keep the shared host Chrome profile signed in
- let `yt-dlp --cookies-from-browser` read that profile directly
- do not rotate YouTube cookies through RTDB for the Hetzner workers

## Verifying the Production Setup

After deployment, run a YouTube job and inspect logs.

Healthy signals:

- `Applying yt-dlp extractor args with PO token provider`
- `public_provider` attempted first
- a non-empty `poTokenProviderBaseUrl`
- `healthz` reports `ytDlpJsRuntime: deno`
- browser fallback only used after classified public/cookie failure
- logs showing one access-decision flow rather than repeated provider thrash

Failure interpretation:

- `public_ip_or_reputation_block`
  - Cloud Run public path was challenged; verify outbound IP reputation and browser fallback health
- `cookie_session_stale`
  - rotate cookies from a fresh private session
- `account_required_no_valid_session`
  - content requires auth and there is no usable cookie/browser session
- `provider_unhealthy`
  - check bgutil provider deployment, readiness, and revision
- `browser_fallback_failed`
  - check worker `healthz`, `session-status`, persistent profile storage, and account login state

## Cloud Run Smoke Test

GET:

```bash
curl \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  https://process-audio-yshbijirxq-uc.a.run.app
```

POST:

```bash
curl \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  https://process-audio-yshbijirxq-uc.a.run.app/process-audio \
  -d '{
    "data": {
      "deleteOriginal": true,
      "id": "fbff2e40-ff55-4ce0-95b8-60ed455188af",
      "introUrl": "https://firebasestorage.googleapis.com/v0/b/urm-app.appspot.com/o/intros%2FBible%20Studies_intro.mp3?alt=media&token=21e3ed85-c569-4609-9f71-258f2cadc491",
      "outroUrl": "https://firebasestorage.googleapis.com/v0/b/urm-app.appspot.com/o/outros%2Fdefault_outro.mp3?alt=media&token=c0748088-dc68-4619-a9a7-ec4f6272f055",
      "duration": 713.5,
      "startTime": 2570.5,
      "youtubeUrl": "https://www.youtube.com/watch?v=MVQ_TCo28jU"
    }
  }'
```

Local:

```bash
curl \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  http://localhost:8080/process-audio \
  -d '{
    "data": {
      "id": "ID",
      "youtubeUrl": "https://www.youtube.com/watch?v=MUIw7qrSW6k",
      "startTime": 5155,
      "duration": 1320
    }
  }'
```

## Download the Latest yt-dlp Binary

[https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp](https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp)
