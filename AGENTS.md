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
- Sentry bootstrap is in [apps/process-audio/src/instrument.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/process-audio/src/instrument.ts).
- Hetzner deploy injects `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, and `SENTRY_TRACES_SAMPLE_RATE` from [scripts/deploy-process-audio-hetzner.sh](/Users/yasaad/Projects/upper-room-media/web-app/scripts/deploy-process-audio-hetzner.sh).
- GCP secret name for the Hetzner runtime is `PROCESS_AUDIO_SENTRY_DSN` in both `urm-app` and `urm-app-staging`.

When working on Hetzner `process-audio`:

- keep `GET /healthz` reporting `sentryEnabled`, `sentryEnvironment`, and `sentryRelease`
- verify Sentry from the live container before declaring deploy success
- ignore synthetic smoke-test issues in Sentry after verification so the queue stays clean

Primary docs:

- [apps/process-audio/README.md](/Users/yasaad/Projects/upper-room-media/web-app/apps/process-audio/README.md)
- [ops/process-audio-hetzner/README.md](/Users/yasaad/Projects/upper-room-media/web-app/ops/process-audio-hetzner/README.md)
