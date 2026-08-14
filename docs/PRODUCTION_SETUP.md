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
4. The six App Hosting secret names exist in `urm-app`.
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
