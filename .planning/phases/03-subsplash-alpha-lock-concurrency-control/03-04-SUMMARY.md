---
phase: 03-subsplash-alpha-lock-concurrency-control
plan: 04
subsystem: api
tags: [firebase-functions, subsplash, locks, idempotency, jest]
requires:
  - phase: 03-subsplash-alpha-lock-concurrency-control/03-01
    provides: lock/idempotency primitives and contention error contract
provides:
  - Lock-guarded upload/edit/delete sermon mutation callables
  - Operation-key idempotency replay contract across sermon media mutations
  - Regression coverage for lock contention payloads and wrapper mock determinism
affects: [subsplash-mutations, publishing-admin-callables, phase-04-tests]
tech-stack:
  added: []
  patterns:
    - operationKey + lock target validation before mutation execution
    - withIdempotency wrapper around withSubsplashLocks for replay-safe mutations
key-files:
  created:
    - functions/src/test/subsplash/deleteFromSubsplash.locking.test.ts
    - functions/src/test/subsplash/editSubsplashSermon.locking.test.ts
    - functions/src/test/subsplash/uploadToSubsplash.locking.test.ts
    - functions/src/test/subsplash/sharedMockContracts.test.ts
  modified:
    - functions/src/uploadToSubsplash.ts
    - functions/src/editSubsplashSermon.ts
    - functions/src/deleteFromSubsplash.ts
    - functions/src/test/series/mocks.ts
    - functions/src/test/soundcloud/mocks.ts
key-decisions:
  - "Use operationKey as required input on upload/edit/delete and require upload lockKey when subsplashId does not exist yet."
  - "Execute withIdempotency outside withSubsplashLocks so duplicate retries replay without rerunning external side effects."
  - "Stabilize shared firebase-function test mocks (onCall overload + HttpsError.details) to keep lock suites deterministic."
patterns-established:
  - "Mutation callable envelope: auth/env validation -> operation/lock validation -> idempotent lock-guarded mutation."
  - "Busy contention handling: always surface HttpsError('aborted') with SUBSPLASH_LOCK_BUSY details."
requirements-completed: [LOCK-02, LOCK-03, LOCK-04]
duration: 6m
completed: 2026-03-01
---

# Phase 03 Plan 04: Sermon Mutation Lock Contract Summary

**Sermon upload/edit/delete callables now enforce operation-key idempotency with media-item locking and consistent busy/error contracts.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-03-01T07:51:07Z
- **Completed:** 2026-03-01T07:57:15Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments
- Normalized upload/edit/delete callable validation and replaced sentinel error returns with typed `HttpsError` throws.
- Applied `withIdempotency` + `withSubsplashLocks` to all sermon media mutation endpoints with required lock scopes.
- Added focused regression tests for contention payloads, operation-key replay behavior, and shared mock compatibility.

## Task Commits

Each task was committed atomically:

1. **Task 1: Normalize sermon/media callable input and error contracts for lock integration**
2. `cddb11b` (test): failing contract tests
3. `cf720d2` (feat): callable contract normalization
4. **Task 2: Apply lock + idempotency wrappers to sermon/media mutation paths**
5. `7ee2f56` (test): failing wrapper integration tests
6. `76164b4` (feat): wrapper integration implementation
7. **Task 3: Add lock/idempotency regression suites for sermon/media callables**
8. `2303307` (test): failing shared mock contract regression tests
9. `130ab97` (test): shared mock stabilization + passing regression tests

## Files Created/Modified
- `functions/src/uploadToSubsplash.ts` - Enforces mutation envelope and executes upload inside idempotent media-item lock.
- `functions/src/editSubsplashSermon.ts` - Applies required `operationKey` + lock-scoped patch mutation behavior.
- `functions/src/deleteFromSubsplash.ts` - Adds operation-key validation and lock/idempotency wrappers for delete mutations.
- `functions/src/test/subsplash/*.locking.test.ts` - Verifies auth/input contracts, busy payload details, wrapper usage, and replay behavior.
- `functions/src/test/subsplash/sharedMockContracts.test.ts` - Guards shared mock compatibility assumptions used by lock regression suites.
- `functions/src/test/series/mocks.ts` - Makes `onCall` mock signature-flexible and adds `HttpsError.details`.
- `functions/src/test/soundcloud/mocks.ts` - Aligns mock `onCall` behavior and `HttpsError` detail support with wrapper-era expectations.

## Decisions Made
- Required upload `lockKey` because upload does not have a Subsplash media ID at request start.
- Kept existing success payload shapes unchanged while upgrading mutation error semantics to typed throws.
- Added shared mock contract checks to prevent future lock-suite flakiness from incomplete Firebase HTTPS mocks.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Firestore emulator port conflict during Task 3 verification**
- **Found during:** Task 3 verification (`firebase emulators:exec ... src/test/subsplash`)
- **Issue:** Default Firestore emulator port `18081` was already occupied by a sibling process.
- **Fix:** Executed verification with a temporary firebase config using alternate emulator ports.
- **Files modified:** None (runtime verification workaround only)
- **Verification:** Alternate-port emulator run completed with `4/4` subsplash suites passing.
- **Committed in:** N/A (no code change)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope change; verification completed successfully with isolated local port overrides.

## Issues Encountered
- Initial GSD helper path in workflow docs referenced `~/.claude/...`; this workspace uses `~/.codex/...`, so equivalent commands were run from the codex path.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Sermon/media mutation surfaces now follow the same lock/idempotency contract expected by downstream reliability work.
- Regression coverage exists for busy contention and replay semantics, ready for broader integration in phase 04.

---
*Phase: 03-subsplash-alpha-lock-concurrency-control*
*Completed: 2026-03-01*

## Self-Check: PASSED

- FOUND: `.planning/phases/03-subsplash-alpha-lock-concurrency-control/03-04-SUMMARY.md`
- FOUND commit: `cddb11b`
- FOUND commit: `cf720d2`
- FOUND commit: `7ee2f56`
- FOUND commit: `76164b4`
- FOUND commit: `2303307`
- FOUND commit: `130ab97`
