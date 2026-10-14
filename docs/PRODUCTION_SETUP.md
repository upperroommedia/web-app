# Production Infrastructure Setup

Complete these one-time external setup steps before the first production deployment from `main`.

## 1. Confirm production project billing

App Hosting requires Blaze:

- [Upgrade `urm-app` to Blaze](https://console.firebase.google.com/project/urm-app/usage/details)

## 2. Create App Hosting backend in production

Run after Blaze is enabled:

```bash
firebase apphosting:backends:create --project urm-app --location us-central1
```

When prompted, set:

- Backend id: `web-prod`
- Root dir: `apps/web`

After the backend is created, open the backend settings in Firebase Console and set:

- Live branch: `main`
- Environment name: `prod`

With environment name `prod`, App Hosting will merge [`apphosting.yaml`](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/apphosting.yaml) with [`apphosting.prod.yaml`](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/apphosting.prod.yaml) for production rollouts.

## 2b. Keep automatic App Hosting rollouts enabled

Production App Hosting should keep rolling out from Firebase Console whenever `main` changes:

- Open App Hosting backend settings for `web-prod`.
- Confirm the backend is connected to the `main` branch.
- Confirm automatic rollouts remain enabled.

## 3. Configure App Hosting secrets for production

Create the same secret names in `urm-app` that staging already uses:

```bash
firebase apphosting:secrets:set ADMIN_REQUEST_RECIPIENTS --project urm-app
firebase apphosting:secrets:set RUNTIME_ALERT_RECIPIENTS --project urm-app
firebase apphosting:secrets:set ADMIN_BASE_URL --project urm-app
firebase apphosting:secrets:set SUBSPLASH_EMAIL --project urm-app
firebase apphosting:secrets:set SUBSPLASH_PASSWORD --project urm-app
firebase apphosting:secrets:set ALGOLIA_SEARCH_API_KEY --project urm-app
firebase apphosting:secrets:set WEB_APP_SENTRY_DSN --project urm-app
firebase apphosting:secrets:set IMAGE_PROCESSING_FUNCTION_URL --project urm-app
```

Grant those same secret names to backend `web-prod`:

```bash
firebase apphosting:secrets:grantaccess ADMIN_REQUEST_RECIPIENTS --project urm-app --backend web-prod
firebase apphosting:secrets:grantaccess RUNTIME_ALERT_RECIPIENTS --project urm-app --backend web-prod
firebase apphosting:secrets:grantaccess ADMIN_BASE_URL --project urm-app --backend web-prod
firebase apphosting:secrets:grantaccess SUBSPLASH_EMAIL --project urm-app --backend web-prod
firebase apphosting:secrets:grantaccess SUBSPLASH_PASSWORD --project urm-app --backend web-prod
firebase apphosting:secrets:grantaccess ALGOLIA_SEARCH_API_KEY --project urm-app --backend web-prod
firebase apphosting:secrets:grantaccess WEB_APP_SENTRY_DSN --project urm-app --backend web-prod
firebase apphosting:secrets:grantaccess IMAGE_PROCESSING_FUNCTION_URL --project urm-app --backend web-prod
```

## 3b. Configure Cloud Functions secrets/env (production)

Set/update Functions secrets in production:

```bash
firebase functions:secrets:set ADMIN_BASE_URL --project urm-app
firebase functions:secrets:set SUBSPLASH_EMAIL --project urm-app
firebase functions:secrets:set SUBSPLASH_PASSWORD --project urm-app
firebase functions:secrets:set ALGOLIA_SEARCH_API_KEY --project urm-app
firebase functions:secrets:set SOUNDCLOUD_CLIENT_ID --project urm-app
firebase functions:secrets:set SOUNDCLOUD_CLIENT_SECRET --project urm-app
firebase functions:secrets:set PROVIDER_EGRESS_RELAY_TOKEN --project urm-app
firebase functions:secrets:set FUNCTIONS_SENTRY_DSN --project urm-app
```

Notes:

- App Hosting resolves the same secret names independently in each Firebase project.
- `WEB_APP_SENTRY_DSN` is resolved by App Hosting from [apps/web/apphosting.yaml](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/apphosting.yaml).
- `FUNCTIONS_SENTRY_DSN` is required by [functions/src/sentry.ts](/Users/yasaad/Projects/upper-room-media/web-app/functions/src/sentry.ts) for every split codebase that initializes Sentry.
- `apps/web/apphosting.prod.yaml` overrides only the project-specific values; shared secret names remain in `apps/web/apphosting.yaml`.
- App Hosting secrets do not automatically flow into Cloud Functions.
- GitHub Actions release automation also needs repository secret `SENTRY_AUTH_TOKEN`; see [docs/SENTRY_SETUP.md](/Users/yasaad/Projects/upper-room-media/web-app/docs/SENTRY_SETUP.md).

## 4. Configure GitHub OIDC for production backend deploys

The `main-selective-deploy` workflow uses the same repository secrets as staging:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT_EMAIL`

That service account must have deploy access to `urm-app`.

## 5. First-deploy readiness checklist

Before merging `staging` into `main`, confirm:

1. `web-prod` exists and points at `apps/web`.
2. `web-prod` live branch is `main`.
3. `web-prod` environment name is `prod`.
4. The required App Hosting secret names exist in `urm-app`, including `IMAGE_PROCESSING_FUNCTION_URL`.
5. `WEB_APP_SENTRY_DSN` also exists in `urm-app`.
6. Each App Hosting secret is granted to `web-prod`.
7. The required Functions secrets, including `FUNCTIONS_SENTRY_DSN`, exist in `urm-app`.
8. Automatic App Hosting rollouts are enabled for `web-prod`.

## 6. Validate the pipeline

1. Merge `staging` into `main`.
2. Confirm Firebase Console creates a production App Hosting rollout from the `main` branch.
3. Confirm the production backend uses `apps/web/apphosting.prod.yaml`.
4. Confirm `main-selective-deploy` runs for backend changes.
5. Confirm runtime requests point at `urm-app`, not `urm-app-staging`.

## 7. Repair Subsplash series item subtitles

Series sermons use their published Subsplash position for subtitles such as
`Part 4 of Sowing Seeds`. The live add, reorder, remove, and rename workflows keep
these values synchronized. Use the idempotent backfill after introducing the
feature or to audit production drift later.

Dry-run first:

```bash
BACKFILL_EMAIL="$(gcloud secrets versions access latest --secret=SUBSPLASH_EMAIL --project=urm-app)"
BACKFILL_PASSWORD="$(gcloud secrets versions access latest --secret=SUBSPLASH_PASSWORD --project=urm-app)"
SUBSPLASH_EMAIL="$BACKFILL_EMAIL" SUBSPLASH_PASSWORD="$BACKFILL_PASSWORD" \
  FIREBASE_PROJECT_ID=urm-app NODE_ENV=production pnpm backfill:series-item-subtitles
```

Apply only after the dry-run reports the expected scope:

```bash
SUBSPLASH_EMAIL="$BACKFILL_EMAIL" SUBSPLASH_PASSWORD="$BACKFILL_PASSWORD" \
  FIREBASE_PROJECT_ID=urm-app NODE_ENV=production pnpm backfill:series-item-subtitles --apply
```

Use `--series-id=<firestoreSeriesId>` to scope either mode to one series. Apply
mode re-reads remote title, membership, positions, and subtitles while holding
the same Subsplash locks as live publishing mutations.

## 8. Extension-to-function-kit migration

Follow [Firebase's user migration guide](https://firebase.google.com/docs/extensions/users/migrate). The CLI migration was attempted before creating local kits. Algolia and Invertase do not supply a linked kit for the installed extensions, and the official email kit's published 0.0.1 package had an empty entrypoint. Licensed local replacements are registered in `firebase.json`; their READMEs document upstream provenance and migration-specific behavior.

Use Node 22 and the repository-pinned Firebase CLI 15.33.0 (kits require at least 15.32.0). Configuration was exported with `firebase ext:export --mode functions`. Preserve `FIREBASE_SECRET_REF_*` bindings to existing Secret Manager resources and all exported `EXT_MIGRATED_SYSTEM_*` options; do not replace them with plaintext credentials.

Deploy kits separately from the original function codebases:

```bash
node scripts/create-kit-deploy-config.mjs --install
pnpm exec firebase deploy --project urm-app --config firebase.kits.json --only functions
```

The generated file is disposable. Predeploy compiles kit source, and each isolated npm package supplies its own Linux-compatible lockfile. Original codebase deployments use the generated `firebase.legacy.json` instead. CI serializes function mutations to avoid overlapping deploys.

### Search indexing

The five production instances are `images-index`, `lists-index`, `sermons-index`, `speakers-index`, and `users-index`. Their replacement live and backfill handlers retain the existing collection/index names and write-key secret references. Check each kit's logs for completed backfill, compare representative Firestore records with Algolia, and verify real search before retiring its old extension. A successful function deploy alone does not establish a successful backfill.

To retry backfill after correcting a failure:

```bash
pnpm exec firebase functions:lifecycle:run afterFirstDeploy sermons-index --project urm-app --config firebase.kits.json
```

Use the relevant instance ID for each index. Backfills and live writes share transaction leases, reread current source state, and wait for Algolia tasks; indexing failures are retried rather than silently discarded. The private `_algoliaSyncLocks` collection must remain inaccessible to clients. Firestore reads/metadata writes, Cloud Tasks, and Algolia consume their normal service quotas.

### Email delivery

The replacement `firestore-send-email` kit uses the existing `mail` queue and SMTP secret. Avoid two active email consumers during cutover: the Firestore delivery lease prevents concurrent claims, but SMTP submission and Firestore completion cannot be atomic. Retire the old consumer after verifying the replacement, and use explicit `delivery.state=RETRY` for failed messages. Preserve configured TTL on `delivery.expireAt`.

SMTP authentication can be verified without sending a message. Kit tests mock delivery; a completed queue document can also exercise deployed event handling without creating a new email. Keep message content, recipients, and SMTP credentials out of validation logs.

### Image API and App Hosting

The new production handler is:

```text
https://us-central1-urm-app.cloudfunctions.net/kit-image-processing-api-handler
```

Set App Hosting's `IMAGE_PROCESSING_FUNCTION_URL` secret to this URL and grant it to `web-prod`. The shared App Hosting configuration exposes it at both BUILD and RUNTIME because Next.js resolves the `/_fah/image/process` rewrite during the build. Changing the secret requires a new App Hosting rollout from the promoted `main` source; it does not change the routing in an already-built release.

Backend console overrides take precedence over YAML. Remove any stale literal `IMAGE_PROCESSING_FUNCTION_URL` override before rebuilding; the managed secret is the canonical setting.

Verify transformed dimensions/content type directly and through the hosted `/_fah/image/process` route after rollout. Keep the old image extension installed until that hosted route reaches the new handler successfully. Local `firebase.json` targets App Hosting backend `web-staging`; production web promotion must use the configured `main`/`web-prod` branch wiring, rather than a generic local App Hosting deploy command.

### Live migration verification (October 11, 2026)

The production email kit processed completed-record probes with HTTP 204, and SMTP connection/authentication was verified without sending a message. The original email extension is retired. The image secret now targets the kit, the stale backend override is removed, and a rollout of existing `main` commit `a961491de457a346aeb051845a21c8a29294a99c` succeeded. Both the direct and hosted image routes returned WebP at the requested 92 × 30 dimensions; the original production image extension is retired.

All five search kits processed live updates successfully. Backfills for images (2,707), lists (1,458), sermons (3,569), speakers (638), and users (10) completed. Representative Algolia records match Firestore and contain no temporary probe fields. The original search extensions have been retired after this verification. `ext:list --project urm-app` returns no instances; all 12 replacement kit functions are ACTIVE, and no `ext-` functions remain. Staging search remains deliberately excluded. Dependency and source improvements are in the workspace and need normal staging-to-main promotion; the image cutover rollout did not publish these uncommitted changes.

### Tooling and verification

The workspace uses pnpm 11.28.2 after its official CLI migration, Next.js 16.4, React 19.3, Firebase SDK 12.19, Admin SDK 13.10, and Functions SDK 7.4. The runtime remains Node 22. Further major upgrades requiring incompatible caller changes are deferred; dependency updates should use available migration CLIs before manual edits and preserve the deployed request contracts.

The audited `8f519c6` checkout used for the staging candidate has three moderate production-dependency advisories through Node Vibrant/file-type, fast-xml-parser, and UUID. This is a lockfile audit, not a scan of live production; `main` and production have not been promoted to this candidate. The default-main Dependabot snapshot had 21 alerts, 15 of which were already fixed in the `8f519c6` checkout. The isolated dependency follow-up removes the obsolete image parser, updates compatible runtime dependencies, and tests narrowly scoped transitive fixes; its workspace production audit, four split Functions npm lock audits, and three unchanged kit production npm lock audits report zero advisories. This follow-up has not yet been promoted or deployed, so its audit results do not describe the live runtime. Google Auth Library 11 is migrated in the candidate with real loopback request/response contract tests. Five development-only advisory IDs remain, including one high advisory without an available stable patch; see [dependency security maintenance](DEPENDENCY_SECURITY.md) for the exact scope and limitations. Recheck audits at release time.

Run frontend/type checks, startup-load guards, kit unit tests, and dedicated-emulator functions regressions when changing migration code. Emulator-backed tests must use `firebase.test.json` and run serially; do not attach Jest to the development emulators. Live cutover checks complement these tests and must finish before extension removal.
