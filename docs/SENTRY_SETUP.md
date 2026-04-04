# Sentry Setup

This repo currently targets three Sentry projects in org `upper-room-media`:

- `process-audio-hetzner`
- `web-app`
- `firebase-functions`

## Release naming

Use environment-prefixed commit releases so staging and production never share the same release version:

- `process-audio-hetzner@staging-<git_sha>`
- `process-audio-hetzner@production-<git_sha>`
- `web-app@staging-<git_sha>`
- `web-app@production-<git_sha>`
- `firebase-functions@staging-<git_sha>`
- `firebase-functions@production-<git_sha>`

Current implementation details:

- Hetzner deploys set `SENTRY_RELEASE` from [scripts/deploy-process-audio-hetzner.sh](/Users/yasaad/Projects/upper-room-media/web-app/scripts/deploy-process-audio-hetzner.sh).
- `apps/web` derives `SENTRY_RELEASE` and `NEXT_PUBLIC_SENTRY_RELEASE` in [apps/web/next.config.js](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/next.config.js).
- Firebase Functions derive release names in [functions/src/sentry.ts](/Users/yasaad/Projects/upper-room-media/web-app/functions/src/sentry.ts), using the git SHA written by [scripts/write-sentry-build-info.mjs](/Users/yasaad/Projects/upper-room-media/web-app/scripts/write-sentry-build-info.mjs).

## GitHub Actions release tracking

The following workflows create Sentry releases and deploy records when `SENTRY_AUTH_TOKEN` is configured as a GitHub repository secret:

- [staging-selective-deploy.yml](/Users/yasaad/Projects/upper-room-media/web-app/.github/workflows/staging-selective-deploy.yml)
- [main-selective-deploy.yml](/Users/yasaad/Projects/upper-room-media/web-app/.github/workflows/main-selective-deploy.yml)
- [staging-process-audio-hetzner-deploy.yml](/Users/yasaad/Projects/upper-room-media/web-app/.github/workflows/staging-process-audio-hetzner-deploy.yml)
- [main-process-audio-hetzner-deploy.yml](/Users/yasaad/Projects/upper-room-media/web-app/.github/workflows/main-process-audio-hetzner-deploy.yml)

Required GitHub secret:

- `SENTRY_AUTH_TOKEN`

The workflows use the official `getsentry/action-release@v3` action with:

- `SENTRY_ORG=upper-room-media`
- `set_commits=auto`
- environment-specific release names

## App Hosting and source maps

`apps/web` uses `@sentry/nextjs` and `withSentryConfig(...)`.

For event capture, only `WEB_APP_SENTRY_DSN` is required.

For source map upload during App Hosting builds, also provide `SENTRY_AUTH_TOKEN` to the App Hosting build environment. Without it, browser stack traces will remain minified even if release tracking works.

Current App Hosting setup expects:

- secret: `WEB_APP_SENTRY_AUTH_TOKEN`
- env var: `SENTRY_AUTH_TOKEN`
- availability: `BUILD`

This works with the existing [apps/web/next.config.js](/Users/yasaad/Projects/upper-room-media/web-app/apps/web/next.config.js) `withSentryConfig(...)` wrapper, which already passes `authToken: process.env.SENTRY_AUTH_TOKEN`.

Verification target for `web-app`:

- a production `next build` should upload source maps automatically
- Sentry should show the release and deploy
- browser frames should resolve by Debug ID instead of showing minified `_next/static/chunks/*.js` output

## GitHub code mappings

Integration page:

- `https://upper-room-media.sentry.io/settings/integrations/github/391483/?tab=codeMappings`

Repository:

- `upperroommedia/web-app`

Recommended mappings:

### `process-audio-hetzner`

- Stack Trace Root: `apps/process-audio/dist/`
- Source Code Root: `apps/process-audio/`

`process-audio` emits inline-source sourcemaps from `dist/*.js.map`, so this mapping is primarily for server-side source linking.

Runtime observability notes:

- Sentry bootstrap is in [apps/process-audio/src/instrument.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/process-audio/src/instrument.ts).
- Winston-to-Sentry log forwarding is configured in [apps/process-audio/src/WinstonLogger.ts](/Users/yasaad/Projects/upper-room-media/web-app/apps/process-audio/src/WinstonLogger.ts).
- The Hetzner deploy sets:
  - `SENTRY_TRACES_SAMPLE_RATE=0.1`
  - `SENTRY_ENABLE_LOGS=true`
  - `SENTRY_LOG_LEVELS=warn,error`
- `GET /healthz` should report:
  - `sentryEnabled`
  - `sentryEnvironment`
  - `sentryRelease`
  - `sentryLogsEnabled`
  - `sentryLogLevels`
  - `sentryTracesSampleRate`

### `firebase-functions`

Add one mapping per compiled output root:

- Stack Trace Root: `functions-core/lib/functions-core/`
- Source Code Root: `functions-core/`
- Stack Trace Root: `functions-core/lib/functions/`
- Source Code Root: `functions/`
- Stack Trace Root: `functions-core/lib/packages/shared/`
- Source Code Root: `packages/shared/`
- Stack Trace Root: `functions-core/lib/packages/contracts/`
- Source Code Root: `packages/contracts/`

- Stack Trace Root: `functions-media/lib/functions-media/`
- Source Code Root: `functions-media/`
- Stack Trace Root: `functions-media/lib/functions/`
- Source Code Root: `functions/`
- Stack Trace Root: `functions-media/lib/packages/shared/`
- Source Code Root: `packages/shared/`
- Stack Trace Root: `functions-media/lib/packages/contracts/`
- Source Code Root: `packages/contracts/`

- Stack Trace Root: `functions-image/lib/functions-image/`
- Source Code Root: `functions-image/`
- Stack Trace Root: `functions-image/lib/functions/`
- Source Code Root: `functions/`
- Stack Trace Root: `functions-image/lib/packages/shared/`
- Source Code Root: `packages/shared/`
- Stack Trace Root: `functions-image/lib/packages/contracts/`
- Source Code Root: `packages/contracts/`

- Stack Trace Root: `functions-integrations/lib/functions-integrations/`
- Source Code Root: `functions-integrations/`
- Stack Trace Root: `functions-integrations/lib/functions/`
- Source Code Root: `functions/`
- Stack Trace Root: `functions-integrations/lib/packages/shared/`
- Source Code Root: `packages/shared/`
- Stack Trace Root: `functions-integrations/lib/packages/contracts/`
- Source Code Root: `packages/contracts/`

These roots match the TypeScript build outputs under each split codebase `lib/` directory.

Source map notes:

- all split functions codebases now compile with:
  - `sourceMap: true`
  - `inlineSources: true`
  - `sourceRoot: "/"`
- this improves server-side source context for uploaded `.map` files and GitHub source linking
- Functions are not currently using a bundler plugin to upload source map artifacts to Sentry; source linking relies on emitted `.map` files plus code mappings

### `web-app`

For `web-app`, uploaded source maps are the primary stack trace mechanism. GitHub code mappings are less important here than for the Node runtimes.

If you want a repo link fallback for server-side frames, use:

- Stack Trace Root: `apps/web/`
- Source Code Root: `apps/web/`

Do not expect GitHub code mappings alone to replace Next.js source map upload for browser bundles.
