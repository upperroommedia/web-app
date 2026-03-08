---
phase: 03-subsplash-alpha-lock-concurrency-control
plan: 07
subsystem: ui
tags: [nextjs, firebase-callable, locking, idempotency, requirements-traceability]
requires:
  - phase: 03-06
    provides: bulkAddToSeries lock/idempotency envelope and caller retry-key contract
provides:
  - operationKey propagation and lock-busy retry guidance on remaining admin delete callers
  - fail-fast external cleanup semantics with structured contention metadata preservation
  - LOCK-01 through LOCK-05 requirement definitions and traceability restoration
affects: [03-verification, admin-series, admin-sermons]
tech-stack:
  added: []
  patterns:
    - shared lock-busy retry message formatting via callableConcurrency helpers
    - external cleanup errors surfaced as structured typed errors without masking details
key-files:
  created:
    - utils/deleteSermonWithExternalCleanup.test.ts
  modified:
    - utils/callableConcurrency.contract.test.ts
    - pages/admin/series.tsx
    - pages/admin/sermons.tsx
    - utils/callableConcurrency.ts
    - utils/deleteSermonWithExternalCleanup.ts
    - .planning/REQUIREMENTS.md
key-decisions:
  - "Series-list deletes now always include createOperationKey('series-admin-delete', selectedSeries.id) in deleteseries payloads."
  - "deleteSermonWithExternalCleanup now fails fast on any external cleanup error and throws ExternalCleanupError with preserved code/details."
  - "LOCK-01..LOCK-05 remain canonical v1 requirements and are marked complete in traceability after 03-07 gap closure."
patterns-established:
  - "Caller contract tests enforce operationKey and lock-busy retry helper adoption for remaining delete entry points."
  - "Lock contention guidance is generated from retry_after_ms via a shared formatter instead of ad-hoc UI strings."
requirements-completed: [LOCK-01, LOCK-02, LOCK-03, LOCK-04, LOCK-05]
duration: 3 min
completed: 2026-03-08
---

# Phase 03 Plan 07: Remaining Delete Caller Contract + LOCK Traceability Summary

**Series-list and sermon-list deletion flows now propagate operation keys, preserve lock-busy metadata across cleanup boundaries, and surface explicit retry guidance while restoring LOCK requirement traceability.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-08T00:32:22Z
- **Completed:** 2026-03-08T00:35:10Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- Added RED/GREEN contract coverage for series-list and sermon-list delete caller lock/idempotency expectations.
- Implemented operationKey propagation and lock-busy retry UX handling across `pages/admin/series.tsx`, `pages/admin/sermons.tsx`, and cleanup utility boundaries.
- Replaced external cleanup swallow semantics with fail-fast structured error propagation and restored LOCK requirements traceability in `.planning/REQUIREMENTS.md`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add failing caller-contract tests for remaining deletion entry points** - `c6271229` (test)
2. **Task 2: Implement operationKey + contention handling in series-list and external cleanup callers** - `c6a1f6ed` (feat)
3. **Task 3: Restore LOCK requirement definitions and traceability coverage** - `f37679ca` (docs)

## Files Created/Modified

- `utils/callableConcurrency.contract.test.ts` - added contract assertions for series-list delete and sermons-list lock-busy retry helper wiring.
- `utils/deleteSermonWithExternalCleanup.test.ts` - added cleanup utility regression tests for operationKey propagation, fail-fast blocking behavior, and contention metadata preservation.
- `pages/admin/series.tsx` - added delete operationKey generation plus lock-busy retry guidance formatting in delete error handling.
- `pages/admin/sermons.tsx` - added lock-busy detail parsing and shared retry guidance formatter in delete toast messaging.
- `utils/callableConcurrency.ts` - added `formatLockBusyRetryMessage` helper for consistent lock contention UX copy.
- `utils/deleteSermonWithExternalCleanup.ts` - added operationKey propagation to `deletefromsubsplash`, fail-fast external cleanup semantics, and typed `ExternalCleanupError` metadata preservation.
- `.planning/REQUIREMENTS.md` - restored LOCK-01..LOCK-05 definitions and traceability rows.

## Decisions Made

- Kept caller retries user-triggered while surfacing deterministic retry guidance from `retry_after_ms`.
- Standardized lock-busy message formatting through shared helper usage to avoid divergence between admin surfaces.
- Preserved callable error metadata (`code`, `details`) through cleanup utility boundaries so UI logic can distinguish contention from generic failures.

## Deviations from Plan

None - plan executed exactly as written.

## Authentication Gates

None.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 03 verification gaps targeted by plan `03-07` are closed and auditable; phase requirement traceability now includes complete LOCK coverage.

## Self-Check: PASSED

- Found summary file: .planning/phases/03-subsplash-alpha-lock-concurrency-control/03-07-SUMMARY.md\n- Found task commit: c6271229\n- Found task commit: c6a1f6ed\n- Found task commit: f37679ca\n