# Sentry JavaScript 11 migration

The web app, Firebase functions, media service and Temporal worker use matching Sentry 11.7 SDKs. Package versions and the workspace lockfile are managed by the application upgrade.

The CLI migration was attempted first: `npx @sentry/wizard@8.0.1 -i upgrade --non-interactive --disable-telemetry --skip-connect`. That release has no `upgrade` integration and rejects the option, so source changes follow the [official migration guide](https://github.com/getsentry/sentry-javascript/blob/develop/MIGRATION.md#upgrading-from-10x-to-11x).

## Collection and logging

Every bootstrap explicitly disables identity, cookies, request/response headers and bodies, query parameters, AI content, database payloads, queue arguments, GraphQL content and stack variable capture. Version 11 otherwise enables broader collection by default. Manual error messages, tags, attributes and extras remain the caller's responsibility: pass safe identifiers and error codes, never provider credentials, intent bodies, invitation tokens or raw request objects.

Browser replay masks all text and blocks media. Firebase, browser, server and worker logging remain disabled through `beforeSendLog`. The media service retains its existing `SENTRY_ENABLE_LOGS` switch and level-filtered Winston transport. Its hook also prevents direct `Sentry.logger` calls from sending when that switch is false. Errors continue to be captured independently of the log switch.

The Next.js build wrapper now imports `@sentry/nextjs/config`, with an explicit build release object. App Hosting build authentication, DSN names, environment/release injection and separate Firebase secrets retain their existing wiring. Runtime health diagnostics retain enabled, environment, release, logs, levels and trace rate fields.

## Verification

`node apps/process-audio/scripts/test-sentry-v11.cjs` compiles the actual media bootstrap and tests the actual SDK with an intercepted transport. It verifies error delivery, enabled and disabled logs, collection policy and exported runtime diagnostics without sending synthetic events to Sentry. Functions unit coverage verifies collection and log policy as well as exception flush behavior. The web bootstrap source and the new build wrapper must typecheck/load against version 11 before release.

No production SDK canary or deployment has been performed as part of source verification. The staging deployment should verify existing Sentry health fields and sanitized event capture before promotion.
