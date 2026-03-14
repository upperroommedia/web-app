# Upper Room Media Web App

## Prerequisites

- Node `22` (see `.nvmrc`)
- `pnpm`

Use:

```bash
nvm use 22
pnpm install
```

The Next.js app now lives in `apps/web`. The repo root is the workspace orchestrator for local tooling, Firebase functions, and deployment metadata.

## Local Development

Create `.env` from template (once):

```bash
pnpm run setup:env
```

If `.env` does not exist, `setup:env` prompts for a Firebase project (from `.firebaserc`) and bootstraps env values from that project (web app config + App Hosting secrets).
The default project selection is `urm-app` when available.
If `.env` already exists, `setup:env` does not pull from Firebase again.
You can also bypass the prompt and choose directly: `pnpm run setup:env -- --project urm-app-staging`.

`pnpm dev`, `pnpm build`, and `pnpm --dir apps/web build` read from the repo-root `.env`/`.env.local` files and do not fetch from Firebase.
Any value can be overridden locally in `.env` or `.env.local` (for example `ADMIN_BASE_URL`).

Run the app:

```bash
pnpm dev
```

This starts the web app and local Firebase emulators used by the project workflow.
By default this runs `auth,functions,firestore,database,storage,tasks` emulators (not `extensions` or `apphosting`).
`pnpm dev` also watches the local functions source tree and rebuilds the compiled function code when relevant files change.
Set `ENABLE_FUNCTIONS_WATCH=0` if you need to disable that background rebuild loop temporarily.
Enable optional emulators when needed:

```bash
EMULATE_EXTENSIONS=1 pnpm dev
EMULATE_APPHOSTING=1 pnpm dev
```

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

Build the web app directly from its deploy root:

```bash
pnpm --dir apps/web build
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
- Firebase App Hosting is configured to build from `apps/web`.
- Vercel should use `apps/web` as the project root in the Upper Room Media team account.
- App Hosting rollouts are manually triggered by the workflow when app-related paths change.
- Keep App Hosting automatic rollouts disabled for `web-staging` so staging pushes do not trigger duplicate App Hosting builds.
- Use `workflow_dispatch` with `force_full_redeploy=true` for a full staging redeploy.

## Required GitHub Secrets For Staging Deploys

- `GCP_WORKLOAD_IDENTITY_PROVIDER` (Workload Identity Provider resource name)
- `GCP_SERVICE_ACCOUNT_EMAIL` (service account used by GitHub OIDC auth)

See [docs/STAGING_SETUP.md](docs/STAGING_SETUP.md) and [docs/STAGING_DEPLOY_ROLLBACK.md](docs/STAGING_DEPLOY_ROLLBACK.md) for setup and rollback procedures.
