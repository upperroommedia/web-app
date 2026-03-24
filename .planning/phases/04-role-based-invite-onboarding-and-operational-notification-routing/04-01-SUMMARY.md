---
phase: 04-role-based-invite-onboarding-and-operational-notification-routing
plan: 01
subsystem: api
tags: [firebase-functions, notifications, firestore, email, runtime-alerts, jest]
requires:
  - phase: 03-subsplash-alpha-lock-concurrency-control/03-04
    provides: lock/idempotency rollout context for runtime error alert expansion
provides:
  - Typed notification payload and queue contracts for role requests and operational alerts
  - Environment-configurable routing params for role-request recipients, runtime-alert recipients, and admin base URL
  - Firestore mail-outbox + operational alert helper with one-alert-per-occurrence behavior
  - Emulator-backed regression coverage for notification queue payloads and alert emission guarantees
affects: [phase-04-role-requests, phase-04-runtime-alert-integration, firebase-trigger-email-extension]
tech-stack:
  added: []
  patterns:
    - Firestore outbox write pattern for extension-delivered emails (`mail` collection)
    - Structured runtime alert logging with queue-based fanout (no dedupe suppression)
key-files:
  created:
    - functions/src/notifications/notificationTypes.ts
    - functions/src/notifications/notificationParams.ts
    - functions/src/notifications/queueEmail.ts
    - functions/src/notifications/emitOperationalAlert.ts
    - functions/src/test/notifications/queueEmail.test.ts
    - functions/src/test/notifications/emitOperationalAlert.test.ts
  modified:
    - functions/src/notifications/notificationParams.ts
key-decisions:
  - "Role-request recipients default to youssef.a.asaad@gmail.com and contact@upperroommedia.org via defineList runtime params."
  - "Operational alerts are intentionally emitted and queued on every invocation, with no dedupe or suppression window."
  - "Outbox documents include structured meta fields (source, alertType, alertCode, queuedAtMs) while remaining Trigger Email compatible."
patterns-established:
  - "Notification helper boundary: build structured payload -> logger.error -> queueEmail."
  - "Param accessors must tolerate local/emulator execution where firebase-functions list params can be unset."
requirements-completed: [ROLE-REQ-02, OPS-ALERT-02]
duration: 8m
completed: 2026-03-01
---

# Phase 04 Plan 01: Notification Foundation Summary

**Shared notification contracts now provide environment-configurable recipient routing plus Firestore outbox/runtime-alert helpers with per-occurrence alert delivery semantics.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-01T08:07:52Z
- **Completed:** 2026-03-01T08:16:36Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- Added typed role-request and runtime-alert notification contracts with reusable queue payload types.
- Introduced notification params for role-request recipients, runtime-alert recipients, and admin base URL.
- Implemented `queueEmail()` and `emitOperationalAlert()` helpers with structured log context and no dedupe behavior.
- Added emulator-backed tests covering outbox payload shape, repeated alert enqueue behavior, and queue-error propagation.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define notification contracts and runtime params** - `71943d8` (feat)
2. **Task 2: Implement Firestore outbox queue and operational alert helper** - `0483259` (feat)
3. **Task 3: Add notification utility emulator tests** - `2ca0861` (fix)

## Files Created/Modified
- `functions/src/notifications/notificationTypes.ts` - Shared typed contracts for role-request payloads, operational alert payloads, and queue transport.
- `functions/src/notifications/notificationParams.ts` - Runtime params/accessors for recipients and admin URL with emulator-safe fallbacks.
- `functions/src/notifications/queueEmail.ts` - Firestore `mail` outbox writer compatible with Trigger Email extension expectations.
- `functions/src/notifications/emitOperationalAlert.ts` - Structured runtime alert emitter that logs and enqueues an email for every occurrence.
- `functions/src/test/notifications/queueEmail.test.ts` - Emulator regression for outbox document shape and metadata fields.
- `functions/src/test/notifications/emitOperationalAlert.test.ts` - Emulator regressions for structured logging, repeated enqueue behavior, and queue failure surfacing.

## Decisions Made
- Used paramized recipient routing via `firebase-functions/params` to keep role-request and runtime alert recipients environment-configurable.
- Kept alert emission behavior explicitly non-deduped to satisfy one-message-per-caught-occurrence semantics.
- Standardized queue metadata fields (`source`, `alertType`, `alertCode`) so downstream monitoring and later plans can route alerts consistently.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Guarded list/string param accessors for emulator execution**
- **Found during:** Task 3 verification (`firebase emulators:exec ... emitOperationalAlert.test.ts`)
- **Issue:** `defineList(...).value()` threw in local emulator tests when runtime params were unset.
- **Fix:** Added resilient fallback parsing in `notificationParams.ts` for list/string params using env/default values.
- **Files modified:** `functions/src/notifications/notificationParams.ts`
- **Verification:** Notification emulator tests passed (`2/2` suites, `4/4` tests).
- **Committed in:** `2ca0861`

**2. [Rule 3 - Blocking] Workspace-specific TypeScript verifier invocation mismatch**
- **Found during:** Task 1/2 verification
- **Issue:** `pnpm exec tsc --noEmit` resolved to a non-TypeScript placeholder command in this workspace layout.
- **Fix:** Used equivalent local compiler binary `../node_modules/.bin/tsc --noEmit` from `functions/` for required type checks.
- **Files modified:** None (verification command adjustment only)
- **Verification:** TypeScript checks passed after each implementation task.
- **Committed in:** N/A

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** No scope creep; fixes were required for correctness and deterministic local verification.

## Issues Encountered
- None beyond the documented deviations.

## User Setup Required

**External services require manual configuration.** See [04-USER-SETUP.md](./04-USER-SETUP.md) for required Trigger Email extension setup and runtime params.

## Next Phase Readiness
- Notification primitives are in place for role-request persistence/notification flow integration in plan `04-02`.
- Runtime alert helper is reusable for later catch-path rollout in plan `04-05`.

---
*Phase: 04-role-based-invite-onboarding-and-operational-notification-routing*
*Completed: 2026-03-01*

## Self-Check: PASSED

- FOUND: `.planning/phases/04-role-based-invite-onboarding-and-operational-notification-routing/04-01-SUMMARY.md`
- FOUND: `.planning/phases/04-role-based-invite-onboarding-and-operational-notification-routing/04-USER-SETUP.md`
- FOUND commit: `71943d8`
- FOUND commit: `0483259`
- FOUND commit: `2ca0861`
