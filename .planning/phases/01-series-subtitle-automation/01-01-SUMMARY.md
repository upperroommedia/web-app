---
phase: 01-series-subtitle-automation
plan: 01
subsystem: series-management
tags: [firebase-functions, firestore, nextjs, series, subsplash]
requires: []
provides:
  - "Series subtitle is derived from published series item count"
  - "Series metadata is recalculated canonically from seriesItems writes"
  - "Create/edit flows no longer accept user-authored series subtitle"
affects: [series-admin-ui, publishing-workflows, series-tests]
tech-stack:
  added: []
  patterns: [server-derived-series-metadata, published-count-subtitle-format]
key-files:
  created:
    - functions/src/DocumentListeners/Series/seriesItemOnWrite.ts
    - functions/src/test/series/seriesMetadata.test.ts
  modified:
    - components/NewSeriesPopup.tsx
    - components/ManagePublishingPopup.tsx
    - pages/admin/series/[seriesId].tsx
    - pages/admin/sermons/[sermonId].tsx
    - functions/src/createSeries.ts
    - functions/src/helpers/seriesHelpers.ts
    - functions/src/index.ts
    - functions/src/test/series/createSeries.test.ts
    - types/Series.ts
key-decisions:
  - "Use a Firestore onWrite trigger on seriesItems as the canonical source for subtitle and count recalculation."
  - "Store subtitle as required series data using the fixed '<publishedCount> part series' format."
  - "Keep publish/unpublish paths responsible for seriesItem published flags while listener reconciles aggregate metadata."
patterns-established:
  - "Series subtitle is never user-authored; it is always computed from publishedItemCount."
  - "Client-side optimistic itemCount updates are avoided when server listeners own aggregate counters."
requirements-completed: [adhoc-series-subtitle-derived-from-published-count]
duration: 33 min
completed: 2026-02-28
---

# Phase 01 Plan 01: Series Subtitle Automation Summary

**Series subtitle and counts are now server-derived from published seriesItems, with UI/API paths removing manual subtitle authoring.**

## Performance

- **Duration:** 33 min
- **Started:** 2026-02-28T21:27:21Z
- **Completed:** 2026-02-28T22:00:45Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments
- Removed subtitle input/edit plumbing from series create/edit UI and createSeries callable input.
- Added a canonical `series/{seriesId}/seriesItems/{itemId}` onWrite listener that recalculates `itemCount`, `publishedItemCount`, and subtitle (`x part series`).
- Updated publish/unpublish flows and series UI rendering to align with published-count-derived subtitle behavior.
- Expanded tests to enforce derived subtitle defaults and published-count regression cases.

## Task Commits

1. **Task 1: Remove custom subtitle input and API plumbing** - `928ea2c` (feat)
2. **Task 2: Make published-count subtitle canonical and self-healing** - `69e26e3` (feat)
3. **Task 3: Update and expand tests for subtitle/count business rule** - `7ccf7e7` (test)

## Files Created/Modified
- `functions/src/DocumentListeners/Series/seriesItemOnWrite.ts` - Canonical series metadata recalculation trigger.
- `functions/src/helpers/seriesHelpers.ts` - Shared pure helpers for subtitle/count derivation.
- `functions/src/createSeries.ts` - Removed subtitle input support and initialized derived subtitle.
- `components/NewSeriesPopup.tsx` - Removed subtitle form field and subtitle payload plumbing.
- `components/ManagePublishingPopup.tsx` - Updated series publish/unpublish item flag/linkage behavior.
- `pages/admin/series/[seriesId].tsx` - Removed manual itemCount writes and rendered derived subtitle text.
- `pages/admin/sermons/[sermonId].tsx` - Updated unpublish behavior and rendered derived series subtitle.
- `functions/src/test/series/createSeries.test.ts` - Updated assertions for derived subtitle defaults.
- `functions/src/test/series/seriesMetadata.test.ts` - Added publish/unpublish/delete and 10/5 regression coverage.

## Decisions Made
- Listener-based recalculation is authoritative for aggregate series metadata to prevent client drift.
- Subtitle remains persisted on series documents, but value is always generated from published count.
- Unpublish paths explicitly clear stale `sermonSubsplashId` on series item docs.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Verification command wrapper failed before running Jest**
- **Found during:** Task 3 verification
- **Issue:** `pnpm test -- series...` routed through `firebase emulators:exec` without forwarding Jest args correctly in this environment, and awaiter-node runtime caused `firebase-tools` pre-test runtime errors.
- **Fix:** Ran equivalent direct verification commands with explicit emulator+jest invocation:
  - `firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest --forceExit series/createSeries.test.ts"`
  - `firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest --forceExit series"`
- **Verification:** All series suites passed (6/6 suites, 62/62 tests).
- **Committed in:** N/A (verification-only workflow adjustment)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope creep; workaround was required to complete verification reliably in current CLI/runtime conditions.

## Issues Encountered
- `STATE.md`, `ROADMAP.md`, and `REQUIREMENTS.md` are not present in `.planning/`, so automated planning-artifact state updates were skipped by design for this run.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Subtitle derivation and aggregate reconciliation are implemented and covered by tests.
- Planning artifacts (`STATE.md` / `ROADMAP.md`) can be initialized later if roadmap/state tracking should continue through gsd-tools commands.

## Self-Check: PASSED
- Verified summary and created files exist on disk.
- Verified task commit hashes `928ea2c`, `69e26e3`, and `7ccf7e7` exist in git history.
