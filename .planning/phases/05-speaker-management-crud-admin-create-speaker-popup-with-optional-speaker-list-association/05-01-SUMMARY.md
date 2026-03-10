---
phase: 05-speaker-management-crud-admin-create-speaker-popup-with-optional-speaker-list-association
plan: 01
subsystem: api
tags: [firebase-functions, firestore, callables, speakers, emulator-tests]
requires: []
provides:
  - "Separate createspeaker/updatespeaker/deletespeaker callable endpoints"
  - "Shared speaker mutation contracts, validation, and list-association orchestration"
  - "Regression test coverage for auth, CRUD behavior, and square-image/list contracts"
affects: [admin-speakers, uploader-speaker-selection, callable-routing]
tech-stack:
  added: []
  patterns: [shared-callable-validation, explicit-boolean-side-effects, firestore-plus-optional-subsplash-orchestration]
key-files:
  created:
    - functions/src/speakers/createSpeakerTypes.ts
    - functions/src/speakers/createSpeaker.ts
    - functions/src/speakers/updateSpeaker.ts
    - functions/src/speakers/deleteSpeaker.ts
    - functions/src/test/speakers/speakerCrudCallables.test.ts
  modified:
    - functions/src/speakers/speakerMutations.ts
    - functions/src/index.ts
key-decisions:
  - "Speaker CRUD is split into separate callables with shared parsing/mutation helpers to keep endpoint behavior consistent."
  - "Optional list side effects are explicit booleans (`createSpeakerList`, `deleteAssociatedList`) with no implicit list mutation."
  - "Speaker-list creation reuses `createNewSubsplashList` and persists a Firestore `ListType.SPEAKER_LIST` document linked by `speaker.listId`."
patterns-established:
  - "Lower-case callable export keys in functions index for v2 URL compatibility."
  - "Square image is required and reused for both speaker image validation and speaker-list payloads."
requirements-completed: [SPK-01, SPK-04, SPK-05]
duration: 12min
completed: 2026-03-10
---

# Phase 5 Plan 1: Speaker CRUD Callables Summary

**Admin speaker lifecycle now runs through dedicated create/update/delete Firebase callables with optional speaker-list association backed by shared validation and mutation orchestration.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-10T04:05:21Z
- **Completed:** 2026-03-10T04:16:50Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- Added typed callable contracts for create, update, and delete speaker operations.
- Implemented shared speaker mutation handlers with duplicate-name checks, square-image enforcement, optional list creation/association, and optional associated-list delete behavior.
- Wired lower-case callable exports (`createspeaker`, `updatespeaker`, `deletespeaker`) in `functions/src/index.ts`.
- Added emulator-backed regression tests for auth, validation, CRUD state transitions, and optional speaker-list association behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define shared speaker mutation contracts and validation helpers** - `887204d4` (feat)
2. **Task 2: Implement createspeaker/updatespeaker/deletespeaker callable orchestration** - `a055e10f` (feat)
3. **Task 3: Add emulator regression tests for speaker callables and image/list contracts** - `495fb8fe` (test)

## Files Created/Modified
- `functions/src/speakers/createSpeakerTypes.ts` - Typed request/response contracts for speaker CRUD callables.
- `functions/src/speakers/speakerMutations.ts` - Shared input parsing, validation helpers, and create/update/delete mutation orchestration.
- `functions/src/speakers/createSpeaker.ts` - Create callable wrapper with auth checks and shared mutation delegation.
- `functions/src/speakers/updateSpeaker.ts` - Update callable wrapper with auth checks and shared mutation delegation.
- `functions/src/speakers/deleteSpeaker.ts` - Delete callable wrapper with auth checks and optional list-delete behavior.
- `functions/src/index.ts` - Lower-case callable exports for speaker CRUD endpoints.
- `functions/src/test/speakers/speakerCrudCallables.test.ts` - Regression suite for auth, validation, CRUD operations, and list/image contracts.

## Decisions Made
- Kept all endpoint-specific validation in shared parser helpers so create/update/delete contracts remain consistent and reusable.
- Preserved immutable speaker identifiers (`id`, `tagId`) during updates by deriving updated records from persisted speaker state.
- Required explicit opt-in flags for list side effects (`createSpeakerList`, `deleteAssociatedList`) to avoid implicit list mutations.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed workspace dependencies to run TypeScript verification**
- **Found during:** Task 1 verification
- **Issue:** `pnpm --dir functions exec tsc --noEmit` failed because local TypeScript binaries were not installed in this worktree.
- **Fix:** Ran `pnpm install` at workspace root, then reran the required TypeScript verification command.
- **Files modified:** None (environment setup only)
- **Verification:** `pnpm --dir functions exec tsc --noEmit` completed successfully
- **Committed in:** N/A (no repository file changes)

---

**Total deviations:** 1 auto-fixed (Rule 3 blocking)
**Impact on plan:** No scope creep; dependency install was required to execute planned verification commands.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Speaker CRUD callable APIs are available for admin UI integration.
- Regression suite is in place to protect auth, validation, and list-association contracts during follow-up UI work.

## Self-Check: PASSED
- Verified expected implementation and summary files exist on disk.
- Verified task commits `887204d4`, `a055e10f`, and `495fb8fe` exist in git history.
