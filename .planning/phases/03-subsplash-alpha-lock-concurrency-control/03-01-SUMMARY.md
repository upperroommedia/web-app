---
phase: 03-subsplash-alpha-lock-concurrency-control
plan: 01
subsystem: api
tags: [firebase-functions, rtdb, firestore, locking, idempotency, jest]
requires:
  - phase: 02-dev-external-api-mocking
    provides: safe emulator-first external integration behavior for local verification
provides:
  - RTDB lease lock primitives with bounded wait, heartbeat refresh, and stale lock takeover
  - deterministic multi-lock orchestration with ordered acquisition and guaranteed release attempts
  - Firestore-backed operation-key idempotency claim/complete/failure persistence with replay
  - standardized lock-busy callable payload contract for caller-managed retries
  - lock-layer emulator tests covering contention, stale recovery, release dead-letter, and idempotency replay
affects: [subsplash mutation callables, callable retry UX, operator lock-failure triage]
tech-stack:
  added: []
  patterns: [read-after-lock mutation sequencing, release failure dead-letter sink, operation-key replay envelope]
key-files:
  created:
    - functions/src/locks/subsplashLockStore.ts
    - functions/src/locks/withSubsplashLocks.ts
    - functions/src/locks/releaseFailureSink.ts
    - functions/src/locks/idempotencyStore.ts
    - functions/src/locks/withIdempotency.ts
    - functions/src/test/locks/subsplashLockStore.test.ts
    - functions/src/test/locks/idempotencyStore.test.ts
  modified:
    - functions/src/locks/lockTypes.ts
    - functions/src/locks/contentionError.ts
    - functions/src/test/locks/contentionError.test.ts
    - functions/src/test/setup.ts
key-decisions:
  - "Lock rows are stored in RTDB under `subsplashLocks/{encodedLockKey}` with lease-based ownership and stale takeover."
  - "Release failures always log structured Cloud Logging events and persist fallback records in Firestore `lockReleaseFailures`."
  - "Failed idempotency records are reclaimable for retries and explicitly clear stale success payloads before re-execution."
patterns-established:
  - "Deterministic lock ordering is global: `series`, then `list`, then `media-item`, then lexical ID."
  - "Concurrent mutation contention surfaces a structured `HttpsError('aborted')` with `SUBSPLASH_LOCK_BUSY` metadata."
requirements-completed: [LOCK-01, LOCK-03, LOCK-04, LOCK-05]
duration: 12 min
completed: 2026-03-01
---

# Phase 03 Plan 01: Lock and Idempotency Substrate Summary

**Reusable RTDB lock orchestration and Firestore idempotency replay primitives now enforce bounded contention handling and duplicate-safe mutation retries for Subsplash writes.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-01T07:29:12Z
- **Completed:** 2026-03-01T07:41:01Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments
- Completed lock contention contract foundation (Task 1) and verified payload schema/default timeout invariants.
- Implemented deterministic RTDB lock lifecycle primitives with heartbeat and stale lock takeover plus release dead-letter sink.
- Implemented operation-key idempotency claim/complete/fail/replay primitives with wrapper-level contention and validation behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define lock contracts and contention payload helpers (RED)** - `b533faf` (test)
2. **Task 1: Define lock contracts and contention payload helpers (GREEN)** - `22dd1cc` (feat)
3. **Task 2: Implement RTDB lock store with deterministic multi-lock orchestration** - `b412177` (feat)
4. **Task 3: Implement operation-key idempotency store and wrapper** - `3376201` (feat)

**Plan metadata:** Recorded in the final docs completion commit for this plan.

## Files Created/Modified
- `functions/src/locks/lockTypes.ts` - shared constants/types for lock ordering, wait defaults, and idempotency states.
- `functions/src/locks/contentionError.ts` - standard `SUBSPLASH_LOCK_BUSY` callable error payload builder.
- `functions/src/locks/subsplashLockStore.ts` - RTDB lock acquire/wait/heartbeat/release with stale-lock reclamation.
- `functions/src/locks/withSubsplashLocks.ts` - deterministic multi-lock orchestration with finally-phase release handling.
- `functions/src/locks/releaseFailureSink.ts` - structured lock release dead-letter logging to Cloud Logging + Firestore.
- `functions/src/locks/idempotencyStore.ts` - operation-key claim/replay/failure persistence and failed-key reclaim behavior.
- `functions/src/locks/withIdempotency.ts` - wrapper enforcing operation-key presence and replay/in-progress behavior.
- `functions/src/test/locks/contentionError.test.ts` - contract tests for busy payload schema and default timeout.
- `functions/src/test/locks/subsplashLockStore.test.ts` - emulator tests for timeout, stale takeover, order, and release dead-letter.
- `functions/src/test/locks/idempotencyStore.test.ts` - emulator tests for claim contention, success replay, and failure metadata handling.
- `functions/src/test/setup.ts` - ensures RTDB emulator host fallback is always set for lock-layer tests.

## Decisions Made
- Used RTDB transaction-based lease ownership with caller tokens to satisfy cross-instance lock coordination and stale takeover requirements.
- Kept retry strategy caller-controlled by returning metadata-only busy payloads instead of server-side retry loops.
- Allowed failed operation keys to be reclaimed by a new claim cycle while preventing stale success replay.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Prevented RTDB transaction writes from including undefined optional fields**
- **Found during:** Task 2 verification
- **Issue:** RTDB rejected lock transaction payloads when `operationKey` was written as `undefined`.
- **Fix:** Conditioned lock-record serialization to omit optional fields unless populated.
- **Files modified:** `functions/src/locks/subsplashLockStore.ts`
- **Verification:** `firebase emulators:exec ... src/test/locks/subsplashLockStore.test.ts` passed.
- **Committed in:** `b412177` (part of Task 2 commit)

**2. [Rule 1 - Bug] Removed undefined nested values from failure metadata writes**
- **Found during:** Task 3 verification
- **Issue:** Firestore rejected failure records when nested `failure.code`/`failure.stack` were undefined.
- **Fix:** Failure serialization now conditionally includes optional fields only when present.
- **Files modified:** `functions/src/locks/idempotencyStore.ts`
- **Verification:** `firebase emulators:exec ... src/test/locks/idempotencyStore.test.ts` passed.
- **Committed in:** `3376201` (part of Task 3 commit)

---

**Total deviations:** 2 auto-fixed (2 bug fixes)
**Impact on plan:** Fixes were required for datastore write correctness; no scope expansion.

## Issues Encountered
- A transient `.git/index.lock` blocked staging during Task 2 commit preparation. Resolved by retrying git operations after the stale lock cleared.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Shared lock/idempotency substrate is in place and validated under emulator tests.
- Phase 03-02 callable migration work can now compose `withSubsplashLocks` and `withIdempotency` directly.

## Self-Check: PASSED
- Found summary file and all task commit hashes (`b533faf`, `22dd1cc`, `b412177`, `3376201`).

---
*Phase: 03-subsplash-alpha-lock-concurrency-control*
*Completed: 2026-03-01*
