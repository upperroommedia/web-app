# Upper Room Media Web App

## Prerequisites

- Node `22` (see `.nvmrc`)
- `pnpm`

Use:

```bash
nvm use 22
pnpm install
```

## Local Development

Run the app:

```bash
pnpm dev
```

This starts the web app and local Firebase emulators used by the project workflow.

## Firebase Functions Codebases

Functions are split into isolated Firebase codebases to reduce cold-start load:

- `functions-core`
- `functions-media`
- `functions-image`
- `functions-integrations`

Each codebase builds independently and is wired in `firebase.json`.

Build all codebases:

```bash
pnpm build-functions-codebases
```

Run startup-load guard (checks that `core` does not load heavy/media/client-sdk deps at module load time):

```bash
pnpm check:function-startup-loads
```

## Local Functions Test Examples

Converter-focused test with Firestore emulator:

```bash
cd functions
pnpm exec firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest src/test/firestoreDataConverter.test.ts --runInBand"
```

Full functions tests that need auth + firestore:

```bash
cd functions
pnpm exec firebase emulators:exec --only firestore,auth --config ../firebase.test.json "pnpm exec jest --forceExit"
```

## Release Branch Contract

- Feature work merges into `staging`.
- Production promotion must happen via PR from `staging` into `main`.
- PRs into `main` from any non-`staging` branch are blocked by CI (`main-from-staging`).

## Staging Deployment Pipeline

- Pushes to `staging` run `.github/workflows/staging-selective-deploy.yml`.
- Deploys are path-filtered and target Firebase project `urm-app-staging`.
- App Hosting rollouts are manually triggered by the workflow when app-related paths change.
- Keep App Hosting automatic rollouts disabled for `web-staging` so staging pushes do not trigger duplicate App Hosting builds.
- Use `workflow_dispatch` with `force_full_redeploy=true` for a full staging redeploy.

## Required GitHub Secrets For Staging Deploys

- `GCP_WORKLOAD_IDENTITY_PROVIDER` (Workload Identity Provider resource name)
- `GCP_SERVICE_ACCOUNT_EMAIL` (service account used by GitHub OIDC auth)

See [docs/STAGING_SETUP.md](docs/STAGING_SETUP.md) and [docs/STAGING_DEPLOY_ROLLBACK.md](docs/STAGING_DEPLOY_ROLLBACK.md) for setup and rollback procedures.
