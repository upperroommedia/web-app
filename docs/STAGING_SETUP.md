# Staging Infrastructure Setup

This repository is now configured for staging-first promotions and selective Firebase backend deploys. App Hosting remains connected to GitHub through the Firebase console. Complete these one-time external setup steps before the first staging deployment.

## Publishing simulation

For isolated Subsplash and SoundCloud testing, follow [Staging provider sandbox](STAGING_PROVIDER_SANDBOX.md) and the [simulation UI guide](STAGING_PROVIDER_SIMULATION_UI.md). The sandbox keeps real Firebase and Temporal processing while storing simulated destination changes privately in staging. Email delivery is captured privately too. Deployment configuration and a reviewed catalog import are required before these flows are available; merging the code alone does not enable them.

Use the release controller for admission changes. During a controlled migration, keep automatic App Hosting rollouts paused until the controller restores them; the normal setup below describes the steady state after that release completes.

### Local verification

Emulator-backed tests use the unchanged `firebase.test.json` configuration. Browser test helpers derive their emulator endpoints from that file and pass these development-only overrides to Next.js:

| Service | Public port override | Normal dev default |
| --- | --- | --- |
| Auth | `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT` | 9099 |
| Firestore | `NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT` | 8081 |
| Realtime Database | `NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR_PORT` | 9000 |
| Storage | `NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_PORT` | 9199 |
| Functions | `NEXT_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT` | 5001 |

Hosts remain `127.0.0.1`; overrides must be integer ports from 1 through 65535. These values do not select a publishing mode or change production endpoints. An existing Admin Auth emulator endpoint supplied by `firebase emulators:exec` is preserved.

Authenticated media tests build the production app once and reuse its verified standalone output for media checks and a fresh cold-navigation server. They sign in through the existing Google button and Firebase Auth emulator account picker, using a separate Google-linked demo administrator. Real named-query bundles and uploader directory records come from isolated demo Firebase services; exact test-only routes serve six catalog endpoints and the uploader-directory callable. Owned WAV routes isolate playback regressions; actual uploaded assets still require a live end-to-end check. Failed media runs retain their test traces for three days.

`NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS=true` is reserved for the production-mode CI build: it requires the exact `demo-temporal-ci` configuration, dedicated test ports, loopback origins and isolated Admin environment. Invalid targets fail before SDK initialization. Staging and production deployments leave this flag absent and use their real Firebase projects. The CI artifact receipt binds build output to its compiled configuration; these checks establish neither live staging readiness nor real-device performance.

Catalog failures offer a retry and pause new upload submissions while preserving local audio and destination choices. Accepted uploads continue through their existing receipts and recovery paths without requiring a catalog refresh.

Functions test commands run `typecheck:tests` before starting emulators. This checks the complete Functions and orchestration test roots with strict TypeScript, then Jest uses isolated file transforms to avoid repeating the same project type check in each worker. Tests still run serially with the worker memory limit. GitHub Actions receives Jest annotations and a final summary.

Before a direct, focused Jest invocation, run `pnpm --dir functions run typecheck:tests` to retain the complete type check. Firebase Functions compile to ES2022 for the configured Node 22 runtime.

The Storage emulator does not currently enforce Cloud Storage's atomic `ifGenerationMatch: 0` create-only condition or preserve historical object generations. The sandbox SDK suite checks that limitation explicitly. Its concurrent-copy test supplies the missing create-only condition only at the exact test object's stream boundary; the first write, source reads, byte measurements, and Firestore transactions still use the real emulator SDKs. This is not proof that the emulator implements Cloud Storage preconditions.

Cloud Storage's [documented precondition contract](https://docs.cloud.google.com/storage/docs/request-preconditions) remains the production requirement. A separate check against a fresh private object in the staging bucket confirmed one successful write and three precondition rejections under four concurrent create-only uploads, with read-back bytes matching the winner. That Storage-only check does not establish full publishing-flow readiness.

## 1. Upgrade staging project billing (required)

App Hosting requires Blaze:

- [Upgrade `urm-app-staging` to Blaze](https://console.firebase.google.com/project/urm-app-staging/usage/details)

## 2. Create App Hosting backend in staging project

Run after Blaze is enabled:

```bash
firebase apphosting:backends:create --project urm-app-staging --location us-central1
```

When prompted, set backend id to `web-staging` and root dir to `apps/web`.

After the backend is created, open the backend settings in Firebase Console and set:

- Live branch: `staging`
- Environment name: `staging`

With environment name `staging`, App Hosting will merge [`apphosting.yaml`](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/apphosting.yaml) with [`apphosting.staging.yaml`](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/apphosting.staging.yaml) for staging rollouts.

If the backend already exists with the old repository-root setting, update the App Hosting backend root directory to `apps/web` before the next rollout.

## 2b. Leave automatic App Hosting rollouts enabled

App Hosting should continue rolling out from Firebase Console on pushes to the `staging` branch:

- Open App Hosting backend settings for `web-staging`.
- Confirm the backend is connected to the `staging` branch.
- Confirm automatic rollouts remain enabled.

## 3. Configure App Hosting secrets for staging

Create/grant each secret in `urm-app-staging`:

```bash
firebase apphosting:secrets:set ADMIN_REQUEST_RECIPIENTS --project urm-app-staging
firebase apphosting:secrets:set RUNTIME_ALERT_RECIPIENTS --project urm-app-staging
firebase apphosting:secrets:set ADMIN_BASE_URL --project urm-app-staging
firebase apphosting:secrets:set SUBSPLASH_EMAIL --project urm-app-staging
firebase apphosting:secrets:set SUBSPLASH_PASSWORD --project urm-app-staging
firebase apphosting:secrets:set ALGOLIA_SEARCH_API_KEY --project urm-app-staging
firebase apphosting:secrets:set WEB_APP_SENTRY_DSN --project urm-app-staging
firebase apphosting:secrets:set IMAGE_PROCESSING_FUNCTION_URL --project urm-app-staging
```

If access is not auto-granted:

```bash
firebase apphosting:secrets:grantaccess <SECRET_NAME> --project urm-app-staging --backend web-staging
```

## 3b. Configure Cloud Functions secrets/env (staging)

Functions that send invite/role-request emails now read `ADMIN_BASE_URL` from Functions Secret Manager.
Set/update Functions secrets in staging:

```bash
firebase functions:secrets:set ADMIN_BASE_URL --project urm-app-staging
firebase functions:secrets:set SUBSPLASH_EMAIL --project urm-app-staging
firebase functions:secrets:set SUBSPLASH_PASSWORD --project urm-app-staging
firebase functions:secrets:set ALGOLIA_SEARCH_API_KEY --project urm-app-staging
firebase functions:secrets:set SOUNDCLOUD_CLIENT_ID --project urm-app-staging
firebase functions:secrets:set SOUNDCLOUD_CLIENT_SECRET --project urm-app-staging
firebase functions:secrets:set PROVIDER_EGRESS_RELAY_TOKEN --project urm-app-staging
firebase functions:secrets:set FUNCTIONS_SENTRY_DSN --project urm-app-staging
```

Notes:

- `ADMIN_BASE_URL` is consumed by invite and role-request email link builders.
- `SUBSPLASH_EMAIL` and `SUBSPLASH_PASSWORD` are consumed by Subsplash publish/sync functions and related triggers.
- `ALGOLIA_SEARCH_API_KEY` is consumed by `generateSecuredApiKey`.
- `SOUNDCLOUD_CLIENT_ID` and `SOUNDCLOUD_CLIENT_SECRET` are consumed by the SoundCloud OAuth bootstrap and automatic token refresh flow.
- `PROVIDER_EGRESS_RELAY_TOKEN` authenticates Firebase Functions requests to the Hetzner provider relay and is also injected into the matching Hetzner environment.
- `WEB_APP_SENTRY_DSN` is consumed by App Hosting via [apps/web/apphosting.yaml](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/apphosting.yaml).
- `FUNCTIONS_SENTRY_DSN` is consumed by [functions/src/sentry.ts](/Users/yasaad/Projects/upper-room-media/web-app/functions/src/sentry.ts) and must be present before deploying any split codebase with Sentry enabled.
- App Hosting secrets in `apphosting.yaml` do not automatically flow into Cloud Functions.
- GitHub Actions release automation also needs repository secret `SENTRY_AUTH_TOKEN`; see [docs/SENTRY_SETUP.md](/Users/yasaad/Projects/upper-room-media/web-app/docs/SENTRY_SETUP.md).

## 3c. Enable Google Sign-In in staging Auth (one-time)

If Google provider is not yet enabled in `urm-app-staging`, configure `google.com` default IdP config:

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)
curl -X POST "https://identitytoolkit.googleapis.com/v2/projects/urm-app-staging/defaultSupportedIdpConfigs?idpId=google.com" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-user-project: urm-app-staging" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"clientId":"<GOOGLE_OAUTH_CLIENT_ID>","clientSecret":"<GOOGLE_OAUTH_CLIENT_SECRET>"}'
```

## 4. Provision staging databases (one-time)

Create Firestore default database:

```bash
gcloud firestore databases create --project=urm-app-staging --database='(default)' --location=us-central1 --type=firestore-native --quiet
```

Create Realtime Database instance (used by staging runtime config):

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)
curl -X POST "https://firebasedatabase.googleapis.com/v1beta/projects/251680231116/locations/us-central1/instances?databaseId=urm-app-staging-815ca" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-user-project: urm-app-staging" \
  -H "Content-Type: application/json" \
  -d '{"type":"USER_DATABASE"}'
```

Create the default Realtime Database instance (required for Firebase CLI `database` deploy flows):

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)
curl -X POST "https://firebasedatabase.googleapis.com/v1beta/projects/251680231116/locations/us-central1/instances" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-user-project: urm-app-staging" \
  -H "Content-Type: application/json" \
  -d '{"type":"DEFAULT_DATABASE"}'
```

Map RTDB deploy target to the staging instance:

```bash
firebase target:apply database rtdb urm-app-staging-815ca --project urm-app-staging
```

## 4b. Allow Storage rules to read their Firestore reservations

Storage rules validate each durable upload against its Firestore job. Grant the
[documented cross-service role](https://firebase.google.com/docs/rules/manage-deploy#manage_permissions_for_cross-service)
to staging's existing Firebase Storage service agent:

```bash
gcloud projects add-iam-policy-binding urm-app-staging \
  --member=serviceAccount:service-251680231116@gcp-sa-firebasestorage.iam.gserviceaccount.com \
  --role=roles/firebaserules.firestoreServiceAgent --condition=None
```

The Firebase CLI's non-interactive rules deployment skips its interactive check
for this permission. A successful rules deployment therefore does not establish
upload readiness. The Temporal controller verifies the role before backend
readiness and admission opening; pausing remains available if the role is missing.
Allow IAM changes to propagate, then verify a real authenticated source upload.
Keep job ownership, reservation size and immutable-source rules enforced.

## 5. Configure GitHub OIDC for staging deploy workflow

Create a Workload Identity Provider and service account with Firebase deploy permissions, then add these repository secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT_EMAIL`

## 6. Validate the pipeline

1. Open a PR from any feature branch into `staging` and confirm `staging-selective-deploy` passes.
2. Merge into `staging` and confirm selective deploy executes.
3. Confirm Firebase Console starts the automatic App Hosting rollout from `staging`; the selective backend workflow does not trigger an additional rollout.
4. Confirm the staging App Hosting backend picks up `apps/web/apphosting.staging.yaml`.
5. Open PR `staging -> main` and confirm `main-from-staging` passes.
6. Open PR `feature -> main` and confirm `main-from-staging` fails.

## 7. Vercel parity

In the Upper Room Media team account, update the Vercel project root directory for this project to `apps/web` so Vercel and App Hosting build the same deploy unit.

## 8. Function kits and temporary search exception

See the [production migration procedure](PRODUCTION_SETUP.md#8-extension-to-function-kit-migration) and [Firebase's migration guide](https://firebase.google.com/docs/extensions/users/migrate). The replacement email and image kits have been deployed to staging. The email native trigger and completed-record probes were verified (HTTP 204), and the original email extension is retired. The staging image extension remains available for its existing hosted routing. The existing staging Algolia application no longer resolves in DNS, and the user chose to skip staging search while completing production migration. Its disappearance from the Algolia account has not been established from DNS failure alone.

Staging CI therefore generates its kit deployment configuration with search excluded:

```bash
node scripts/create-kit-deploy-config.mjs --install --without-search
pnpm exec firebase deploy --project urm-app-staging --config firebase.kits.json --only functions
```

Staging's original Algolia extensions remain installed. The attempted replacement `images-index` instance was removed and its backfill queue paused. Search is unavailable until an Algolia application and project-specific search/write credentials are restored. Do not reuse production indexes or production write-key bindings for staging.

The staging web configuration also sets `NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED=false` at build time. All browser search clients, secured-key initialization and Algolia preconnects honor this setting, so inherited credentials cannot send requests to the missing application. Speaker, list and image selection retain bounded Firestore browsing with pagination and retry controls; full-text search displays an unavailable message. Browsing never substitutes an unbounded collection scan.

When staging search is restored:

1. Create or recover a staging Algolia application and separate indexes.
2. Update all five staging instance configurations and their Secret Manager write-key bindings, plus App Hosting/Functions `ALGOLIA_SEARCH_API_KEY` and the staging web application ID.
3. Remove `--without-search` from the staging workflow after configuration is ready, set `NEXT_PUBLIC_ALGOLIA_SEARCH_ENABLED=true` in `apps/web/apphosting.staging.yaml`, and build a new App Hosting rollout. A runtime-only change cannot update an already compiled browser bundle.
4. Deploy the replacements, resume/recreate the managed backfill queues as needed, and verify indexing and real web search before retiring the original extensions.

Email authentication was verified in both projects without sending real messages. Continue to use local/mocked delivery for package tests and avoid creating email queue messages merely to smoke-test deployment. Preserve the delivery lease and configured Firestore TTL.

For the image API, set the project-specific `IMAGE_PROCESSING_FUNCTION_URL` App Hosting secret to the deployed staging kit handler and grant it to `web-staging`. The secret must be available at BUILD and RUNTIME; a new App Hosting rollout is required to update the compiled rewrite. Keep the original image extension until the hosted `/_fah/image/process` route has been verified against its replacement.

The CLI version, isolated kit lockfiles, deployment separation, and dedicated-emulator testing requirements are shared with production. Default `pnpm dev` excludes extensions/kits; use `pnpm dev:mail` only after building the email kit as described in the root README.
