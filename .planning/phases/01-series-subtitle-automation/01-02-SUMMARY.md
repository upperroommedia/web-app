---
phase: 01-series-subtitle-automation
plan: 02
subsystem: ui
tags: [subsplash, series, firestore, publishing, jest]
requires:
  - phase: 01-01
    provides: series metadata derivation and listener wiring for subtitle/count updates
provides:
  - independent series publishing flow not gated by list publication
  - explicit Publish Everywhere convenience action with partial-failure handling
  - strict published-item count semantics based only on publishedToSubsplash
  - one-time backfill tooling for legacy seriesItems publish flags
  - regression tests for strict count and independent addToSeries behavior
affects: [series publishing UX, admin series page metadata, functions series test suite]
tech-stack:
  added: []
  patterns: [strict boolean publish-state semantics, dry-run-first migration script]
key-files:
  created:
    - docs/series-publish-workflow.md
    - scripts/backfillSeriesPublishedFlags.ts
  modified:
    - components/ManagePublishingPopup.tsx
    - components/UploadStatusList.tsx
    - pages/admin/series/[seriesId].tsx
    - functions/src/test/series/seriesMetadata.test.ts
    - functions/src/test/series/addToSeries.test.ts
    - functions/package.json
key-decisions:
  - "Series published counts remain strict and ignore inferred fallback state."
  - "Backfill runs dry-run by default and requires explicit --apply for writes."
  - "Series verification used direct emulator+jest commands because pnpm test argument forwarding remained unreliable."
patterns-established:
  - "Series membership truth is explicit: only publishedToSubsplash === true increments published count."
  - "Combined publish is additive convenience; list-only and series-only paths remain first-class."
requirements-completed: [adhoc-series-publish-independent-from-lists, adhoc-publish-everywhere-shortcut]
duration: 12 min
completed: 2026-02-28
---

# Phase 01 Plan 02: Series Publishing Independence Summary

**Independent series publishing with optional Publish Everywhere convenience flow, strict published-count semantics, and a dry-run-first legacy backfill path.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-02-28T23:05:55Z
- **Completed:** 2026-02-28T23:18:08Z
- **Tasks:** 5
- **Files modified:** 8

## Accomplishments
- Preserved previously completed Tasks 1-3 and resumed without redoing work.
- Added legacy reconciliation tooling and operational documentation for strict publish semantics.
- Expanded regression coverage for independent series publishing and strict count behavior.

## Task Commits

Each task was committed atomically:

1. **Task 1: Decouple series publish from list publish gating** - `11407f5` (feat)
2. **Task 2: Add optional one-click "Publish Everywhere" convenience flow** - `c496a04` (feat)
3. **Task 3: Enforce strict series-published counting model** - `b8c7dbd` (fix)
4. **Task 4: Add one-time legacy reconciliation/backfill path** - `a59c217` (feat)
5. **Task 5: Add tests for independent and combined publish flows** - `52d2846` (test)

**Plan metadata:** Recorded in the final docs completion commit for this plan.

## Files Created/Modified
- `scripts/backfillSeriesPublishedFlags.ts` - dry-run/apply reconciliation of Firestore series item flags from real Subsplash membership.
- `docs/series-publish-workflow.md` - operator runbook for independent vs combined publish and QA checklist.
- `functions/src/test/series/seriesMetadata.test.ts` - strict publish count contract tests for missing/false state.
- `functions/src/test/series/addToSeries.test.ts` - callable coverage proving series publish is not list/local-gating dependent.
- `functions/package.json` - test script invocation updated to run jest via `pnpm exec` inside emulator context.

## Decisions Made
- Maintained strict published-count semantics (`publishedToSubsplash === true` only) with no runtime inference fallback.
- Kept backfill as an explicit operator action rather than reintroducing app-layer fallback logic.
- Used direct `firebase emulators:exec "pnpm exec jest ..."` commands for targeted `series/*` verification in this environment.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed emulator test runner pathing for Jest**
- **Found during:** Task 5 verification
- **Issue:** `pnpm test` invoked bare `jest` inside emulator exec and failed with `jest: command not found`.
- **Fix:** Updated `functions/package.json` test scripts to use `pnpm exec jest --forceExit`.
- **Files modified:** `functions/package.json`
- **Verification:** Targeted series test suites executed successfully through emulator runs.
- **Committed in:** `52d2846` (part of Task 5 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Unblocked required verification flow for Task 5 without changing feature behavior.

## Issues Encountered
- `pnpm test` over the full functions suite still reports unrelated pre-existing failures in `src/test/addToList/*` concurrency tests. Series-focused verification passed and those addToList failures were left out of scope for this plan.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 01-02 deliverables are complete and documented.
- Phase 01 is ready for closeout once metadata/state docs are committed.

## Self-Check: PASSED
- Found summary file and all task commit hashes (`11407f5`, `c496a04`, `b8c7dbd`, `a59c217`, `52d2846`).

---
*Phase: 01-series-subtitle-automation*
*Completed: 2026-02-28*
