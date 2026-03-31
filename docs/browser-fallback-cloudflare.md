# Browser Fallback on Cloudflare Containers

This deploy path moves only the `browser-fallback` worker off Google Cloud while leaving `process-audio` on Cloud Run.

## Why

- `process-audio` public and cookie paths still run on Cloud Run.
- `browser-fallback` is the only component that must escape Google Cloud egress for challenged YouTube requests.
- The fallback service already stores browser state in Firebase Storage and RTDB, so it can be restarted on another host without local disk persistence.

## Runtime Shape

1. `process-audio` fails public extraction.
2. `process-audio` fails or skips the cookie path.
3. `process-audio` calls the Cloudflare Worker URL in `YOUTUBE_BROWSER_FALLBACK_URL`.
4. The Worker forwards the request to one named Cloudflare Container instance.
5. The container runs the existing Express service from `apps/browser-fallback`.
6. The service resolves audio or uploads a signed section artifact to Firebase Storage.
7. `process-audio` continues exactly as before.

## Required Secrets

- Cloudflare Worker secret: `FIREBASE_SERVICE_ACCOUNT_JSON`
- Cloudflare Worker secret: `BROWSER_FALLBACK_SHARED_SECRET`
- GCP Secret Manager secret for `process-audio`: `BROWSER_FALLBACK_SHARED_SECRET`

The service-account JSON must belong to a principal that can:

- read and write the staging or production profile objects in Firebase Storage
- read and write `processAudioQueues/youtube/browserFallback/profileLease` in RTDB
- upload fallback artifacts to the configured Firebase Storage bucket

## Deploy Staging

```bash
export FIREBASE_SERVICE_ACCOUNT_JSON="$(cat /path/to/staging-service-account.json)"
export BROWSER_FALLBACK_SHARED_SECRET="$(openssl rand -hex 32)"

printf '%s' "$FIREBASE_SERVICE_ACCOUNT_JSON" | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON --config wrangler.browser-fallback.jsonc --env staging
printf '%s' "$BROWSER_FALLBACK_SHARED_SECRET" | npx wrangler secret put BROWSER_FALLBACK_SHARED_SECRET --config wrangler.browser-fallback.jsonc --env staging

npx wrangler deploy --config wrangler.browser-fallback.jsonc --env staging
```

Then mirror the same shared secret into GCP and point staging at the Worker URL:

```bash
printf '%s' "$BROWSER_FALLBACK_SHARED_SECRET" | gcloud secrets create BROWSER_FALLBACK_SHARED_SECRET --project urm-app-staging --data-file=- 2>/dev/null || \
printf '%s' "$BROWSER_FALLBACK_SHARED_SECRET" | gcloud secrets versions add BROWSER_FALLBACK_SHARED_SECRET --project urm-app-staging --data-file=-

WORKER_URL="https://browser-fallback-staging.<your-subdomain>.workers.dev"

node scripts/set-browser-fallback-runtime-config.mjs urm-app-staging https://urm-app-staging-default-rtdb.firebaseio.com/ "$WORKER_URL" true
BROWSER_FALLBACK_SERVICE_URL="$WORKER_URL" bash scripts/deploy-process-audio.sh staging "$(git rev-parse HEAD)"
```

## Preferred Interim Path: Named Cloudflare Tunnel

If `wrangler deploy` fails after the image build with an authorization error against the Cloudflare container registry path, the Cloudflare account is blocked from publishing the container image. The working fallback is a named Cloudflare Tunnel pointed at a non-Google `apps/browser-fallback` process.

Flow:

1. Run `apps/browser-fallback` on a non-Google machine.
2. Authenticate `cloudflared` with `cloudflared tunnel login`.
3. Create a named tunnel and route a stable hostname such as `browser-fallback-staging.upperroommedia.org`.
4. Reuse the same `BROWSER_FALLBACK_SHARED_SECRET`.
5. Point RTDB runtime config and `process-audio` at the stable hostname.

Example:

```bash
export PORT=8090
export FIREBASE_PROJECT_ID=urm-app-staging
export FIREBASE_STORAGE_BUCKET=urm-app-staging.firebasestorage.app
export FIREBASE_DATABASE_URL=https://urm-app-staging-default-rtdb.firebaseio.com/
export BROWSER_FALLBACK_PROFILE_BUCKET=urm-app-staging.firebasestorage.app
export BROWSER_FALLBACK_SHARED_SECRET="$(cat /path/to/shared-secret.txt)"

./scripts/with-node22.sh pnpm --dir apps/browser-fallback start
cloudflared tunnel login
cloudflared tunnel create browser-fallback-staging
cloudflared tunnel route dns browser-fallback-staging browser-fallback-staging.upperroommedia.org
cat > ~/.cloudflared/browser-fallback-staging.yml <<'YAML'
tunnel: <tunnel-id>
credentials-file: /Users/<user>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: browser-fallback-staging.upperroommedia.org
    service: http://127.0.0.1:8090
  - service: http_status:404
YAML
cloudflared tunnel --config ~/.cloudflared/browser-fallback-staging.yml run browser-fallback-staging
```

Then point staging at the named hostname:

```bash
gh secret set STAGING_BROWSER_FALLBACK_SERVICE_URL \
  --repo upperroommedia/web-app \
  --body https://browser-fallback-staging.upperroommedia.org

node scripts/set-browser-fallback-runtime-config.mjs \
  urm-app-staging \
  https://urm-app-staging-default-rtdb.firebaseio.com/ \
  https://browser-fallback-staging.upperroommedia.org \
  true

gcloud run services update process-audio-staging \
  --project urm-app-staging \
  --region us-central1 \
  --update-env-vars YOUTUBE_BROWSER_FALLBACK_URL=https://browser-fallback-staging.upperroommedia.org/fallback
```

## Smoke Test

```bash
curl -fsS "$WORKER_URL/session-status"

curl -fsS -X POST "$WORKER_URL/fallback" \
  -H 'content-type: application/json' \
  -H "x-browser-fallback-secret: $BROWSER_FALLBACK_SHARED_SECRET" \
  --data '{"action":"resolve_audio_url","youtubeUrl":"https://youtu.be/dKaZ89SkVYY"}'
```
