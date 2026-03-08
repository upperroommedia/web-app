---
phase: quick-1-prevent-sermon-counter-overwrites-in-edit-writes
plan: 1
subsystem: api
tags: [firestore, firebase-functions, counters, tdd, emulator]
requires:
  - phase: 02-dev-external-api-mocking
    provides: existing sermon/list listener architecture and firestore data model
provides:
  - Counter-safe sermon edit writes that cannot clobber listener-owned fields
  - Invariant guard that auto-recalculates impossible sermon counters from subcollection truth
  - Emulator-backed regression tests for valid and invalid counter states
affects: [sermon-editing, sermon-list-listeners, publishing-counters]
tech-stack:
  added: []
  patterns:
    - Explicit allowlist patch builder for editable sermon writes
    - Post-listener invariant enforcement with recalc fallback
key-files:
  created:
    - utils/buildEditableSermonPatch.ts
    - functions/src/utils/sermonCountInvariantGuard.ts
    - functions/src/test/sermonCounts/sermonCountInvariantGuard.test.ts
  modified:
    - pages/api/editSermon.ts
    - functions/src/DocumentListeners/SermonLists/sermonListOnCreate.ts
    - functions/src/DocumentListeners/SermonLists/sermonListOnUpdate.ts
    - functions/src/DocumentListeners/SermonLists/sermonListOnDelete.ts
key-decisions:
  - "Use updateDoc + allowlist patch for sermon edits to keep listener-owned counters write-protected."
  - "Use deleteField() for absent seriesId so edit writes can clear series without invalid null typing."
  - "Run invariant guard after listener counter mutations and repair from sermonLists truth."
patterns-established:
  - "Listener-owned counters are never written by edit APIs."
  - "Counter mutations are followed by invariant checks to self-heal impossible states."
requirements-completed: [adhoc-sermon-counter-overwrite-guard, adhoc-sermon-counter-invariant-autorecalc]
duration: 8min
completed: 2026-03-01
---

# Phase [quick-1] Plan [1]: Prevent Sermon Counter Overwrites in Edit Writes Summary

**Sermon edit writes now use a counter-safe allowlist patch while sermon-list listeners auto-repair impossible counter states from `sermonLists` truth.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-01T06:48:00Z
- **Completed:** 2026-03-01T06:56:35Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- Replaced whole-document sermon edit writes with `buildEditableSermonPatch` to keep counters listener-owned.
- Added `ensureSermonCountInvariant` guard and wired it into sermon list create/update/delete listeners.
- Added emulator-backed regression tests proving valid counters remain untouched and invalid counters trigger repair.

## Task Commits

1. **Task 1: Enforce counter-safe sermon edit writes** - `338b9e3` (fix)
2. **Task 2: Add listener invariant auto-recalc guard with regression tests (RED)** - `07a71d1` (test)
3. **Task 2: Add listener invariant auto-recalc guard with regression tests (GREEN)** - `5b7b798` (feat)

## Files Created/Modified

- `utils/buildEditableSermonPatch.ts` - allowlist-only edit patch that excludes listener-owned counters.
- `pages/api/editSermon.ts` - uses `updateDoc(..., buildEditableSermonPatch(sermon))` for sermon edits.
- `functions/src/utils/sermonCountInvariantGuard.ts` - invariant checker with recalc fallback and structured repair logging.
- `functions/src/DocumentListeners/SermonLists/sermonListOnCreate.ts` - guard invocation after counter mutation.
- `functions/src/DocumentListeners/SermonLists/sermonListOnUpdate.ts` - guard invocation after upload counter mutation.
- `functions/src/DocumentListeners/SermonLists/sermonListOnDelete.ts` - guard invocation after decrement mutation.
- `functions/src/test/sermonCounts/sermonCountInvariantGuard.test.ts` - emulator-backed invariant regression coverage.

## Decisions Made

- Added a dedicated invariant utility instead of duplicating checks in each listener, so repair logic has one source of truth.
- Kept guard execution fail-safe by propagating errors through existing listener `try/catch` handling.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed `seriesId` patch typing in Task 1**
- **Found during:** Task 1 verification
- **Issue:** `seriesId: null` in editable patch failed TypeScript overload resolution for `updateDoc`.
- **Fix:** Switched absent `seriesId` handling to `deleteField()` in patch builder.
- **Files modified:** `utils/buildEditableSermonPatch.ts`
- **Verification:** `pnpm exec tsc --noEmit` at repo root passed.
- **Committed in:** `338b9e3`

**2. [Rule 1 - Bug] Corrected misleading update-listener log branch during Task 2**
- **Found during:** Task 2 implementation
- **Issue:** update listener logged sermon-missing warning when upload status was unchanged.
- **Fix:** Separated unchanged-status logging from sermon-missing branch while adding guard wiring.
- **Files modified:** `functions/src/DocumentListeners/SermonLists/sermonListOnUpdate.ts`
- **Verification:** emulator-backed tests and functions typecheck passed.
- **Committed in:** `5b7b798`

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both changes were required for correct typed writes and accurate listener diagnostics; no scope creep.

## Issues Encountered

- Firestore emulator emitted recurring watchman recrawl warnings during tests; tests still passed and no functional impact observed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Counter ownership boundaries and self-healing behavior are now enforced by code and tests.
- Existing unrelated working-tree changes remain outside this quick task scope.

## Self-Check: PASSED

- Found summary artifact at `.planning/quick/1-prevent-sermon-counter-overwrites-in-edi/1-SUMMARY.md`.
- Verified task commits exist: `338b9e3`, `07a71d1`, `5b7b798`.
