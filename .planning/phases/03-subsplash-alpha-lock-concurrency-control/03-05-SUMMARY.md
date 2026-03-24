---
phase: 03-subsplash-alpha-lock-concurrency-control
plan: 05
subsystem: ui
tags: [subsplash, callable, idempotency, locks, admin]
requires:
  - phase: 03-02
    provides: series lock/idempotency wrappers and contention contract
  - phase: 03-03
    provides: list lock/idempotency wrappers and contention contract
  - phase: 03-04
    provides: sermon/media lock/idempotency wrappers and contention contract
provides:
  - shared caller-side operation-key generation and lock-busy parsing utilities
  - operation-key propagation across admin mutation surfaces and API helpers
  - explicit lock-contention retry guidance in admin publish/unpublish flows
affects: [phase-03, admin-publishing, subsplash-callers]
tech-stack:
  added: []
  patterns:
    - "Operation key per mutation intent at caller boundary"
    - "Shared lock-busy parser for consistent retry UX"
key-files:
  created:
    - utils/callableConcurrency.ts
    - utils/callableConcurrency.test.ts
    - utils/callableConcurrency.contract.test.ts
  modified:
    - utils/createFunction.ts
    - components/ManagePublishingPopup.tsx
    - pages/admin/series/[seriesId].tsx
    - pages/admin/sermons/[sermonId].tsx
    - pages/api/uploadFile.tsx
    - pages/api/editSermon.ts
key-decisions:
  - "Caller retries remain user-triggered; lock busy responses provide retry_after_ms guidance only."
  - "Operation-key generation is centralized in utils/callableConcurrency.ts and reused across UI/API call sites."
patterns-established:
  - "Mutation callers generate operation keys with scoped prefixes and entity IDs."
  - "UI catch blocks parse SUBSPLASH_LOCK_BUSY details and emit actionable retry messaging."
requirements-completed: [LOCK-03, LOCK-04, LOCK-05]
duration: 5 min
completed: 2026-03-01
---

# Phase 03 Plan 05: Caller Lock/Idempotency Contract Adoption Summary

**Admin publishing callers now attach operation keys/lock keys and surface lock contention with explicit retry timing from callable error details.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-01T08:07:16Z
- **Completed:** 2026-03-01T08:12:26Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments

- Added shared `createOperationKey` and `parseLockBusyDetails` helpers plus focused unit coverage.
- Extended `createFunctionV2` to accept optional metadata so mutation metadata can be passed consistently without ad-hoc casts.
- Propagated operation keys across admin mutation surfaces and API helpers (`uploadToSubsplash`, list lifecycle mutations, series mutations, delete/edit callables).
- Replaced generic lock-contention failures with actionable retry guidance driven by `retry_after_ms`.

## Task Commits

Each task was committed atomically:

1. **Task 1 (TDD RED): shared helper failing tests** - `3b480a7` (test)
2. **Task 1 (TDD GREEN): shared helper + callable metadata plumbing** - `8830744` (feat)
3. **Task 2 (TDD RED): caller contract failing tests** - `13731ef` (test)
4. **Task 2 (TDD GREEN): caller wiring + retry UX** - `89efeb7` (feat)

## Files Created/Modified

- `utils/callableConcurrency.ts` - canonical operation-key and lock-busy parsing helpers.
- `utils/createFunction.ts` - optional callable metadata plumbing for mutation contract fields.
- `utils/callableConcurrency.test.ts` - helper behavior tests (key format/uniqueness + busy parser).
- `utils/callableConcurrency.contract.test.ts` - client integration contract coverage for target call sites.
- `components/ManagePublishingPopup.tsx` - operation-key propagation + busy retry messaging for list/series mutation flows.
- `pages/admin/series/[seriesId].tsx` - operation-key propagation + busy retry messaging for series admin mutation paths.
- `pages/admin/sermons/[sermonId].tsx` - operation-key propagation + busy retry messaging for sermon admin mutation paths.
- `pages/api/uploadFile.tsx` - operation-key metadata on add-intro-outro task generation callable.
- `pages/api/editSermon.ts` - operation-key propagation for `editSubsplashSermon` and busy-detail-aware error alerts.

## Decisions Made

- Keep retries caller-controlled; no automatic hidden retry loops were added.
- Use scoped operation-key prefixes (`manage-publishing-*`, `series-admin-*`, `sermon-admin-*`, `edit-sermon-*`, `upload-file-*`) to make idempotency intent traceable.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] GSD tool path mismatch**
- **Found during:** Initialization
- **Issue:** `~/.claude/get-shit-done/bin/gsd-tools.cjs` did not exist in this environment.
- **Fix:** Switched execution commands to `~/.codex/get-shit-done/bin/gsd-tools.cjs`.
- **Files modified:** None
- **Verification:** `init execute-phase` and subsequent state commands worked via `.codex` path.
- **Committed in:** N/A (runtime execution adjustment only)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope change; required to execute planned workflow in the actual environment.

## Issues Encountered

- Root `pnpm lint`/`pnpm build` are blocked by pre-existing out-of-scope lint errors:
  - `pages/admin/sermons.tsx:110` (`no-void`)
  - `components/uploaderComponents/UploaderComponent.tsx:507` (`no-void`)
- Logged to `.planning/phases/03-subsplash-alpha-lock-concurrency-control/deferred-items.md` and left unchanged per scope boundary rules.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Caller contract adoption for lock/idempotency is implemented and covered by helper + integration tests.
- Remaining global lint blockers must be resolved outside this plan before full root lint/build can pass.

---
*Phase: 03-subsplash-alpha-lock-concurrency-control*
*Completed: 2026-03-01*

## Self-Check: PASSED
