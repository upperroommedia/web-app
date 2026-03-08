---
phase: 03-subsplash-alpha-lock-concurrency-control
plan: 06
subsystem: api
tags: [firebase-functions, subsplash, locking, idempotency, retry-keys]
requires:
  - phase: 03-05
    provides: caller operation-key contract adoption for series/list/sermon mutations
provides:
  - bulkAddToSeries lock + idempotency envelope with stale snapshot rejection
  - deterministic cross-callable lock scope for series/media bulk publish mutations
  - stable intent-scoped retry keys and membership-hash propagation from series admin bulk publish caller
affects: [03-07, series-admin, subsplash-publish]
tech-stack:
  added: []
  patterns:
    - withIdempotency(operationKey) wrapping withSubsplashLocks(lockKeys)
    - deterministic retry keys based on scope/entity/intent fingerprint
key-files:
  created:
    - functions/src/test/series/bulkAddToSeries.locking.test.ts
    - functions/src/test/series/bulkAddToSeries.crossCallableLocking.test.ts
  modified:
    - functions/src/bulkAddToSeries.ts
    - functions/src/test/series/bulkAddToSeries.test.ts
    - pages/admin/series/[seriesId].tsx
    - utils/callableConcurrency.ts
    - utils/callableConcurrency.test.ts
    - utils/callableConcurrency.contract.test.ts
key-decisions:
  - "bulkaddtoseries now requires operationKey and expectedPublishedMembershipHash instead of generating fallback idempotency keys."
  - "bulkaddtoseries lock scope is series:{firestoreSeriesId} plus sorted media-item lock keys to serialize against delete/reorder callables."
  - "series admin bulk publish retries reuse deterministic createRetryIntentKey(scope, seriesId, intentFingerprint) without hidden auto-retries."
patterns-established:
  - "Stale snapshot guard: compare caller expectedPublishedMembershipHash against locked remote membership hash before writes."
  - "Payload safety: reject oversized bulk add payloads up front to protect idempotency document persistence."
requirements-completed: [LOCK-01, LOCK-02, LOCK-03, LOCK-04, LOCK-05]
duration: 14 min
completed: 2026-03-08
---

# Phase 03 Plan 06: bulkAddToSeries Lock + Retry Contract Summary

**bulkAddToSeries now runs inside idempotent deterministic series/media locks, rejects stale membership snapshots, and accepts stable intent-scoped retry keys from the series admin caller.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-03-08T00:11:01Z
- **Completed:** 2026-03-08T00:25:50Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Added RED lock/idempotency/stale-hash/payload-bound regression coverage for bulkAddToSeries, including cross-callable contention.
- Migrated `bulkAddToSeries` to required operation-key idempotency and deterministic lock scope with stale-snapshot precondition checks.
- Added caller-side deterministic retry intent keys and `expectedPublishedMembershipHash` propagation for bulk series publish attempts.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add failing lock/idempotency contract tests for bulkAddToSeries** - `84f639dc` (test)
2. **Task 2: Migrate bulkAddToSeries to lock + idempotency envelope with stale-snapshot and payload safety guards** - `939489e3` (feat)
3. **Task 3: Add stable retry operation key strategy in series detail caller** - `a38d0b56` (feat)

## Files Created/Modified
- `functions/src/test/series/bulkAddToSeries.test.ts` - extended RED/GREEN coverage for operation key, stale snapshot, replay, and payload bounds.
- `functions/src/test/series/bulkAddToSeries.locking.test.ts` - lock/idempotency wrapper and busy payload contract tests.
- `functions/src/test/series/bulkAddToSeries.crossCallableLocking.test.ts` - contention regression test against shared series lock keys.
- `functions/src/bulkAddToSeries.ts` - required operation key + snapshot hash validation, lock/idempotency envelope, stale guard, and bulk bound checks.
- `utils/callableConcurrency.ts` - added `createRetryIntentKey` and `createPublishedMembershipHash`.
- `utils/callableConcurrency.test.ts` - added deterministic retry-key + membership hash unit tests.
- `utils/callableConcurrency.contract.test.ts` - asserted series admin bulk publish caller wiring for retry-intent key and snapshot hash.
- `pages/admin/series/[seriesId].tsx` - bulk publish payload now sends deterministic retry operation key and expected membership hash.

## Decisions Made
- Required client-provided `operationKey` for `bulkaddtoseries` to align with phase lock/idempotency contract and deterministic replay behavior.
- Enforced stale-state protection with `expectedPublishedMembershipHash` to prevent stale reorders from overwriting newer remote membership.
- Kept retry ownership in the caller; contention remains surfaced through structured `SUBSPLASH_LOCK_BUSY` details.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Firestore emulator was not running for targeted Jest verification**
- **Found during:** Task 1 verification
- **Issue:** Direct Jest execution timed out in `clearFirestore` hooks because Firestore emulator port `18081` was unavailable.
- **Fix:** Ran lock/idempotency verification commands via `firebase emulators:exec --only firestore,auth`, reusing the already-running RTDB emulator on port `9000`.
- **Files modified:** None
- **Verification:** All required task suites passed under emulator-backed execution.
- **Committed in:** N/A (execution environment fix)

---

**Total deviations:** 1 auto-fixed (Rule 3)
**Impact on plan:** No scope creep. Change only affected verification environment startup.

## Authentication Gates

None.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan `03-06` outputs are complete and regression-covered. Ready to execute `03-07-PLAN.md`.

## Self-Check: PASSED

- Found summary file: `.planning/phases/03-subsplash-alpha-lock-concurrency-control/03-06-SUMMARY.md`
- Found task commits: `84f639dc`, `939489e3`, `a38d0b56`
