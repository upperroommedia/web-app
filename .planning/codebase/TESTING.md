# Testing Map (Quality Focus)

**Analysis date:** 2026-02-28

## Test stack in active use

- Jest + `ts-jest` is used for backend/functions tests (`functions/jest.config.js`).
- Playwright is used for browser E2E (`playwright.config.ts`, `tests/*.spec.ts`).
- Firestore rules tests exist under root Jest (`jest.config.js`, `test/test.ts`).

## Test locations and intent

- Cloud Functions behavior tests: `functions/src/test/addToList/*.test.ts`, `functions/src/test/removeFromList/*.test.ts`, `functions/src/test/series/*.test.ts`, `functions/src/test/soundcloud/*.test.ts`.
- Backend test bootstrapping: `functions/src/test/setup.ts`.
- E2E user-flow tests: `tests/audio-player.spec.ts`, `tests/audio-trimmer.spec.ts`, `tests/youtube-trimmer.spec.ts`, `tests/player-clear-on-upload.spec.ts`.
- E2E data seeding helper: `tests/helpers/seedPlayableSermon.ts`.
- Firestore rules/security tests: `test/test.ts` with helper in `test/utils.ts`.

## Execution commands (current state)

- Root E2E: `pnpm test:e2e` (script in `package.json`).
- Root E2E headed: `pnpm test:e2e:headed`.
- Functions test suite (Firestore emulator wrapped): `cd functions && pnpm test`.
- Functions verbose mode: `cd functions && pnpm test:verbose`.
- Firestore rules tests are not wired to an npm script; run manually with root Jest, e.g. `pnpm exec jest test/test.ts` (requires emulator alignment; see gaps).

## Emulator and environment strategy

- Functions tests use `firebase emulators:exec` with `../firebase.test.json` (`functions/package.json`).
- `functions/src/test/setup.ts` sets fallback env vars to isolated ports (`FIRESTORE_EMULATOR_HOST=127.0.0.1:18081`, `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9100`) before Admin SDK init.
- Functions Jest runs serially (`maxWorkers: 1` in `functions/jest.config.js`) to avoid shared-emulator race conditions.
- Playwright defaults to `http://localhost:3000` unless `PLAYWRIGHT_BASE_URL` is set (`playwright.config.ts`).
- Playwright covers two projects: `chromium` and `mobile-chrome` (`playwright.config.ts`).

## Mocking and test-double patterns

- Functions tests generally mock external APIs but keep real Firestore emulator state.
- `addToList` tests use a full in-memory Subsplash mock and Axios interception (`functions/src/test/addToList/mocks.ts`).
- Series tests use dedicated Subsplash series mocks with failure injection (`functions/src/test/series/mocks.ts`).
- SoundCloud tests mock `soundcloudClient`, secret access, and storage bucket download behavior (`functions/src/test/soundcloud/mocks.ts`).
- `firebase-functions/v2/https` is mocked in multiple suites to unwrap `onCall` handlers into directly invokable functions.

## Assertion style and reliability patterns

- Functions tests are scenario-driven with explicit setup/act/assert and many edge-case suites (transaction retries, isolation, network failures).
- E2E tests rely on deterministic data seeding and `finally` cleanup (`tests/helpers/seedPlayableSermon.ts`, used across `tests/*.spec.ts`).
- Playwright specs assert behavior through accessibility roles + test IDs (`data-testid` such as `floating-audio-bar`, `trim-slider`, `audio-trim-playhead`).
- Long-running UI behavior is verified with `expect.poll` and explicit visibility timeouts (`tests/youtube-trimmer.spec.ts`).

## Quality gaps and risks in current test setup

- No frontend unit/component test framework is configured for `components/`, `hooks/`, or `context/` (only E2E for client coverage).
- Root Firestore rules tests are detached from scripts and port config appears stale: `test/utils.ts` hardcodes `127.0.0.1:8080`, while app/dev emulators use `8081` (`firebase.json`) and functions-test emulators use `18081` (`firebase.test.json`).
- No active GitHub Actions workflow exists under `.github/workflows/`; automated test gating is not visible in-repo.
- E2E login assumes dev-admin credentials in auth emulator; this requires running `scripts/create-dev-admin.ts` after dev startup.
- E2E coverage concentrates on uploader/trimmer/player flows; admin CRUD pages and many API routes (`pages/api/*`) have no direct automated coverage.
- Legacy/alternate backend paths (e.g. `functions/src/old_addToList.ts`) are outside the primary tested path and can drift.

## Practical pre-run checklist for stable local runs

- Start app + emulators via `pnpm dev` at repo root (`package.json`).
- Seed emulator auth user via `npx ts-node --skip-project scripts/create-dev-admin.ts` (`scripts/create-dev-admin.ts`).
- For functions tests, run from `functions/` so `firebase emulators:exec` uses `firebase.test.json` and isolated emulator ports.
- For Playwright, ensure `PLAYWRIGHT_BASE_URL` matches the active dev port if not using `3000`.
