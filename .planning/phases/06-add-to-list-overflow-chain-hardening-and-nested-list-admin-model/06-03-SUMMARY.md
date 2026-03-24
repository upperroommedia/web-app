---
phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model
plan: 03
subsystem: ui
tags: [algolia, firestore, react, nextjs, overflow-chain, testing]
requires:
  - phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model
    provides: explicit root/overflow metadata, logical totals, and overflow flags on list records
provides:
  - migration-safe root-only discovery helpers shared by Algolia and Firestore-backed flows
  - selector and speaker-assignment filtering that excludes overflow continuation pages
  - admin list-table logical totals, overflow indicators, and name-only sorting
affects:
  - 06-04
  - 06-05
  - admin-lists
  - uploader-list-selection
tech-stack:
  added: []
  patterns:
    - shared migration-safe root-only list discovery helper
    - logical-count display fallback for discovery surfaces
    - admin list sorting constrained to truthful existing replicas
key-files:
  created:
    - apps/web/utils/algolia/searchRecords.test.ts
  modified:
    - apps/web/utils/algolia/searchRecords.ts
    - apps/web/utils/mockAlgoliaSearchClient.ts
    - apps/web/utils/algolia/listSorting.ts
    - apps/web/utils/algolia/listSorting.test.ts
    - apps/web/components/ListSelector.tsx
    - apps/web/components/uploaderComponents/SpeakerSelector.tsx
    - apps/web/components/uploaderComponents/UploaderComponent.tsx
    - apps/web/components/ListTable.tsx
key-decisions:
  - "Discovery treats explicit isRootList metadata as authoritative when present, but falls back to legacy isMoreSermonsList exclusion until brownfield rollout verification is complete."
  - "Logical totals are surfaced as logicalCount ?? count, and overflow awareness falls back from hasOverflowPages to moreSermonsRef for legacy records."
  - "Admin discovery exposes only name sorting in this phase so the UI does not imply truthful count-based replicas before that rollout exists."
patterns-established:
  - "Selectors and speaker-linked list assignment reuse the same root-only helper instead of maintaining separate overflow guards."
  - "Algolia and mock search adapters share one discovery contract and unit coverage for migration-safe fallback behavior."
requirements-completed: [OFLOW-01, OFLOW-02]
duration: 7 min
completed: 2026-03-14
---

# Phase 06 Plan 03: Discovery Root-Only Admin Model Summary

**Migration-safe root-only list discovery now hides overflow continuation pages across selectors and admin search while showing logical totals plus overflow awareness on root rows.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-14T21:10:04Z
- **Completed:** 2026-03-14T21:17:19Z
- **Tasks:** 2 implementation tasks executed
- **Files modified:** 9

## Accomplishments

- Added shared discovery helpers so explicit root metadata wins when present, legacy overflow exclusion remains in place when metadata is absent, and logical totals resolve as `logicalCount ?? count`.
- Updated the mock Algolia client plus the uploader/admin selector surfaces to reuse that shared contract instead of scattered `isMoreSermonsList !== true` checks.
- Changed the admin list table to show logical totals, add an admin-only overflow badge, and suppress misleading count-based sorting until logical-total replicas are introduced.

## Task Commits

Local task commits were **not created** because the environment denies writes inside `.git/`:

1. **Task 1: Convert discovery/search surfaces to a migration-safe root-only model** - not committed (`fatal: Unable to create '.git/index.lock': Operation not permitted`)
2. **Task 2: Hide overflow pages from selectors/tables and surface root overflow indicators** - not committed (`fatal: Unable to create '.git/index.lock': Operation not permitted`)

**Plan metadata:** not committed for the same reason.

## Files Created/Modified

- `apps/web/utils/algolia/searchRecords.ts` - shared root-only discovery helpers, logical-total normalization, and Algolia list-hit filtering
- `apps/web/utils/algolia/searchRecords.test.ts` - regression coverage for explicit-root fallback behavior and logical-count normalization
- `apps/web/utils/mockAlgoliaSearchClient.ts` - emulator-mode list discovery now uses the shared root-only helper and logical totals
- `apps/web/utils/algolia/listSorting.ts` - list discovery sorting is constrained to name-only replicas
- `apps/web/utils/algolia/listSorting.test.ts` - regression coverage for the reduced truthful sort surface
- `apps/web/components/ListSelector.tsx` - manual selector fetch/search paths now reuse the shared root-only discovery contract
- `apps/web/components/uploaderComponents/SpeakerSelector.tsx` - speaker-driven list auto-assignment now rejects overflow continuation pages via the shared helper
- `apps/web/components/uploaderComponents/UploaderComponent.tsx` - uploader subtitle fallback filters now use the same root-only discovery contract
- `apps/web/components/ListTable.tsx` - admin list rows now show logical totals, an overflow badge, and only name sorting

## Decisions Made

- Kept the Algolia filter at legacy-safe `NOT isMoreSermonsList:true` while making explicit `isRootList` metadata authoritative in the shared helper, because brownfield rollout verification is not complete yet.
- Normalized discovery-facing list records to carry `logicalCount` and `hasOverflowPages` fallbacks so admin surfaces can render truthful totals and overflow awareness without waiting for a strict metadata-only rollout.
- Removed count sorting from admin discovery instead of trying to infer logical-total replica behavior from physical `count` values.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Disabled Watchman for targeted Jest verification**
- **Found during:** Task 1 (TDD verification)
- **Issue:** Jest failed before running the new tests because local Watchman state could not update under the current environment permissions.
- **Fix:** Reran the targeted Jest commands with `--watchman=false`.
- **Files modified:** None
- **Verification:** `pnpm --dir apps/web exec jest --config jest.config.js utils/algolia/searchRecords.test.ts --runInBand --watchman=false`, `pnpm --dir apps/web exec jest --config jest.config.js utils/algolia/listSorting.test.ts --runInBand --watchman=false`
- **Committed in:** not committed (git writes blocked by `.git/index.lock` permission failure)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The auto-fix only changed verification flags. No scope creep.

## Issues Encountered

- `git add` / `git commit` are blocked in this environment because `.git/index.lock` cannot be created (`Operation not permitted`), so the required atomic task commits and final docs commit could not be produced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The root-only discovery helper pattern is established and verified for Algolia, mock search, selector flows, speaker-linked assignment, and admin discovery UI.
- Before this plan can be considered fully complete in GSD terms, it needs to be rerun in an environment that allows `.git` writes so the required atomic commits and final metadata commit can be created.

## Self-Check: FAILED

- `FOUND`: `.planning/phases/06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model/06-03-SUMMARY.md`
- `MISSING`: Task commit hashes (git writes blocked by `.git/index.lock` permission failure)
- `MISSING`: Final docs commit (same git write restriction)

---
*Phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model*
*Completed: 2026-03-14*
