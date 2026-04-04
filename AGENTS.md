# Web App Agent Notes

## Post-Build Dev Workflow (Conditional)

Only if you run `pnpm build` and then want to continue in dev mode for exploration/testing, follow this sequence:

1. Stop the current dev process.
2. Run `pnpm dev` from `web-app`.
3. After dev is ready, open another terminal in `web-app` and run:
   `pnpm run create-dev-admin`

This ensures the auth login user exists for local testing.

## Firebase Test Harness

When running emulator-backed functions tests, do not point Jest directly at the already-running dev emulators.

Use the dedicated Firebase test config with `firebase emulators:exec`:

```bash
pnpm --dir functions exec firebase emulators:exec \
  --only auth,firestore,database,storage \
  --config ../firebase.test.json \
  "pnpm exec jest --watchman=false --runInBand --forceExit <test files>"
```

=3
Important details:

- `firebase.test.json` is the source of truth for test emulator ports.
- The test RTDB emulator uses a separate port from normal dev so tests do not collide with `pnpm dev`.
- Do not run multiple `firebase emulators:exec` test commands in parallel for the same project; they will contend on the same test-emulator ports and produce misleading failures.
- Functions tests intentionally clear `SUBSPLASH_DEV_MAX_LIST_SIZE` in `functions/src/test/setup.ts` so test expectations are not polluted by local dev-only `.env` overrides. If a test needs a smaller max list size, set it explicitly inside that test.
- Do not validate functions tests by manually exporting `FIRESTORE_EMULATOR_HOST` / `FIREBASE_DATABASE_EMULATOR_HOST` against the dev stack unless you explicitly want to exercise the live dev session.
- If a test fails with missing docs or unexpected state while the same logic works in dev, first confirm it is running through `firebase emulators:exec --config ../firebase.test.json` before debugging the application code.

## Sentry

Current Sentry rollout status:

- Hetzner `apps/process-audio` is instrumented and deployed to Sentry project `process-audio-hetzner` in org `upper-room-media`.
- `apps/web` is instrumented for Sentry project `web-app` in org `upper-room-media`.
- Firebase Cloud Functions are instrumented for Sentry project `firebase-functions` in org `upper-room-media`.
- Sentry bootstrap is in [apps/process-audio/src/instrument.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/process-audio/src/instrument.ts).
- Frontend bootstrap lives in:
  - [apps/web/sentry.client.config.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/sentry.client.config.ts)
  - [apps/web/sentry.server.config.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/sentry.server.config.ts)
  - [apps/web/sentry.edge.config.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/sentry.edge.config.ts)
  - [apps/web/sentry.shared.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/sentry.shared.ts)
  - [apps/web/pages/_error.tsx](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/pages/_error.tsx)
- Firebase Functions bootstrap is in [functions/src/sentry.ts](/Users/yasaad/Projects/upper-room-media/web-app/functions/src/sentry.ts) and is initialized from each split codebase entrypoint.
- Hetzner deploy injects `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_ENABLE_LOGS`, and `SENTRY_LOG_LEVELS` from [scripts/deploy-process-audio-hetzner.sh](/Users/yasaad/Projects/upper-room-media/web-app/scripts/deploy-process-audio-hetzner.sh).
- GCP secret name for the Hetzner runtime is `PROCESS_AUDIO_SENTRY_DSN` in both `urm-app` and `urm-app-staging`.
- App Hosting secret name for the web app is `WEB_APP_SENTRY_DSN` in both `urm-app` and `urm-app-staging`.
- Functions secret name for Firebase Cloud Functions is `FUNCTIONS_SENTRY_DSN` in both `urm-app` and `urm-app-staging`.
- GitHub Actions release automation expects repository secret `SENTRY_AUTH_TOKEN`.

When working on Hetzner `process-audio`:

- keep `GET /healthz` reporting `sentryEnabled`, `sentryEnvironment`, and `sentryRelease`
- keep `GET /healthz` reporting `sentryLogsEnabled`, `sentryLogLevels`, and `sentryTracesSampleRate` too
- verify Sentry from the live container before declaring deploy success
- ignore synthetic smoke-test issues in Sentry after verification so the queue stays clean

When working on `apps/web`:

- keep App Hosting secrets and Cloud Functions secrets separate; `apphosting.yaml` secrets do not flow into Cloud Functions
- keep [apps/web/apphosting.yaml](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/apphosting.yaml) aligned with the current Sentry secret names
- keep `WEB_APP_SENTRY_AUTH_TOKEN` available to App Hosting builds so Next.js source maps upload during `next build`
- remember local `firebase.json` points App Hosting deploys at backend `web-staging`; production App Hosting should roll from the `main` branch/backend wiring documented in setup docs rather than a naive `firebase deploy --project urm-app --only apphosting`
- if source maps are required, provide `SENTRY_AUTH_TOKEN` at build time; event capture does not depend on it

When working on Firebase Cloud Functions:

- initialize Sentry once through [functions/src/sentry.ts](/Users/yasaad/Projects/upper-room-media/web-app/functions/src/sentry.ts), not ad hoc per handler
- add `functionsSentryDsnSecret` to each split codebase `setGlobalOptions({ secrets: [...] })` list so the DSN is actually available at runtime
- prefer verifying secret discovery with a targeted `firebase deploy --only functions:<codebase> --debug` before assuming all codebases are wired correctly

Primary docs:

- [apps/process-audio/README.md](/Users/yasaad/Projects/upper-room-media/web-app/apps/process-audio/README.md)
- [ops/process-audio-hetzner/README.md](/Users/yasaad/Projects/upper-room-media/web-app/ops/process-audio-hetzner/README.md)
- [docs/SENTRY_SETUP.md](/Users/yasaad/Projects/upper-room-media/web-app/docs/SENTRY_SETUP.md)
- [docs/STAGING_SETUP.md](/Users/yasaad/Projects/upper-room-media/web-app/docs/STAGING_SETUP.md)
- [docs/PRODUCTION_SETUP.md](/Users/yasaad/Projects/upper-room-media/web-app/docs/PRODUCTION_SETUP.md)
