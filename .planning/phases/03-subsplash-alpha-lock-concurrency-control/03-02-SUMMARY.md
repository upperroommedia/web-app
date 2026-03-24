---
phase: 03-subsplash-alpha-lock-concurrency-control
plan: 02
subsystem: api
tags: [subsplash, locking, idempotency, firestore, rtdb, jest]
requires:
  - phase: 03-subsplash-alpha-lock-concurrency-control
    provides: lock/idempotency substrate from plan 03-01
provides:
  - lock-guarded series mutation callables for add/remove/reorder/create/delete
  - operation-key idempotency replay across all series mutation paths
  - standardized busy payload regression coverage in series callable tests
affects: [series publishing, callable retries, admin mutation flows]
tech-stack:
  added: []
  patterns:
    - withIdempotency wrapping withSubsplashLocks for all series mutations
    - read-after-lock enforcement for write-driving lookups
key-files:
  created: []
  modified:
    - functions/src/addToSeries.ts
    - functions/src/removeFromSeries.ts
    - functions/src/reorderSeriesItems.ts
    - functions/src/createSeries.ts
    - functions/src/deleteSeries.ts
    - functions/src/test/series/addToSeries.test.ts
    - functions/src/test/series/removeFromSeries.test.ts
    - functions/src/test/series/reorderSeriesItems.test.ts
    - functions/src/test/series/createSeries.test.ts
    - functions/src/test/series/deleteSeries.test.ts
key-decisions:
  - "Series callables accept optional operationKey and generate a per-request fallback key when omitted to preserve legacy callers."
  - "All series mutation side effects execute inside withSubsplashLocks, with withIdempotency as the outer retry/replay envelope."
  - "Busy payload schema assertions use deterministic in-progress operation-key claims, while reorder keeps a real lock-timeout assertion for 10,000 ms wait budget."
patterns-established:
  - "Pattern: lock scope is keyed by series/media-item domain ownership per callable."
  - "Pattern: idempotency replay is verified by side-effect spy call counts plus stable result payload comparison."
requirements-completed: [LOCK-02, LOCK-03, LOCK-04]
duration: 20min
completed: 2026-03-01
---

# Phase 03 Plan 02: Series Lock + Idempotency Rollout Summary

**Series add/remove/reorder/create/delete callables now run under lock + idempotency guards with consistent busy contention payloads and replay-safe retries.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-03-01T07:42:00Z
- **Completed:** 2026-03-01T08:02:08Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Migrated all series-domain mutation callables to `withIdempotency` + `withSubsplashLocks`.
- Enforced read-after-lock sequencing for reorder/create/delete decisions that drive writes.
- Added/extended emulator-backed tests that validate replay behavior and standardized busy payload details across all series callables.

## Task Commits

Each task was committed atomically:

1. **Task 1: Lock-guard series membership and reorder callables** - `9a45587` (feat)
2. **Task 2: Lock-guard series lifecycle create/delete callables** - `c0c30ca` (feat)
3. **Task 3: Extend series tests for busy payload and idempotency replay** - `956761b` (test)

## Files Created/Modified

- `functions/src/addToSeries.ts` - Added lock/idempotency orchestration and optional operation key handling.
- `functions/src/removeFromSeries.ts` - Added media-item lock scope and operation-key replay wrapper.
- `functions/src/reorderSeriesItems.ts` - Added series lock scope with read-after-lock Firestore + Subsplash membership flow.
- `functions/src/createSeries.ts` - Wrapped create/local-sync flow with per-series lock and idempotency envelope.
- `functions/src/deleteSeries.ts` - Wrapped delete remote+local cleanup flow with per-series lock and idempotency envelope.
- `functions/src/test/series/addToSeries.test.ts` - Added locking/idempotency regression coverage and busy payload assertions.
- `functions/src/test/series/removeFromSeries.test.ts` - Added replay + busy payload contract tests.
- `functions/src/test/series/reorderSeriesItems.test.ts` - Added replay and deterministic 10,000 ms lock-timeout busy assertions.
- `functions/src/test/series/createSeries.test.ts` - Added create replay/busy/lock-release test coverage.
- `functions/src/test/series/deleteSeries.test.ts` - Added delete replay/busy/serialization/lock-release test coverage.

## Decisions Made

- Kept `operationKey` optional in input types and generated fallback per-request keys to avoid breaking existing callers that do not yet send operation keys.
- Standardized lock key scopes per plan contract:
  - `addToSeries`: `series:{seriesSubsplashId}` + `media-item:{mediaItemId}`
  - `removeFromSeries`: `media-item:{mediaItemId}`
  - `reorderSeriesItems`: `series:{firestoreSeriesId}`
  - `createSeries`: `series:{generatedFirestoreId}`
  - `deleteSeries`: `series:{firestoreId}`
- Used direct idempotency claim-based busy tests for deterministic schema checks, and retained explicit lock-timeout testing in reorder for wait-budget validation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected GSD tool path from unavailable `~/.claude` to available `~/.codex` binaries**
- **Found during:** Plan initialization
- **Issue:** Executor bootstrap command failed with `MODULE_NOT_FOUND` for `~/.claude/get-shit-done/bin/gsd-tools.cjs`.
- **Fix:** Switched init/state command invocations to `~/.codex/get-shit-done/bin/gsd-tools.cjs` for this workspace.
- **Files modified:** None (runtime command-path adjustment only)
- **Verification:** `gsd-tools init execute-phase 03` succeeded and returned expected phase metadata.
- **Committed in:** N/A (execution environment correction)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope creep; correction was required to execute the plan workflow in this repository environment.

## Authentication Gates

None.

## Issues Encountered

- Concurrent same-key calls can validly resolve as replayed success or busy rejection depending on timing; deterministic busy-schema assertions were made via pre-claimed in-progress operation keys.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 03-02 lock/idempotency contract is now active for all series mutation callables.
- List and sermon mutation plans can reuse the same callable wrapper + test assertion pattern.

---
*Phase: 03-subsplash-alpha-lock-concurrency-control*
*Completed: 2026-03-01*

## Self-Check: PASSED

- Found summary file: `.planning/phases/03-subsplash-alpha-lock-concurrency-control/03-02-SUMMARY.md`
- Found commits: `9a45587`, `c0c30ca`, `956761b`
