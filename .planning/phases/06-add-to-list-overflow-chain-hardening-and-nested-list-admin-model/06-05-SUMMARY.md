---
phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model
plan: 05
subsystem: ui
tags: [firebase-functions, subsplash, overflow-chain, admin-ui, firestore, testing]
requires:
  - phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model
    provides: root-detail chain diagnostics and read-only overflow-chain aggregation
provides:
  - root-aware reorder callable that repartitions logical order across overflow pages
  - client-side mirror sync using callable page assignments after remote success
  - regression coverage for overflow repartitioning and blocked-chain reorder
affects:
  - 06-07
  - admin list detail
  - reorderlistitems
  - overflow chain persistence
tech-stack:
  added: []
  patterns:
    - root-aware reorder contract that targets one logical chain instead of one physical list
    - callable returns per-page assignment metadata so the admin page can keep Firestore mirrors aligned after remote success
    - overflow reorder stays enabled only when chain diagnostics and local mirror coverage allow safe mutation
key-files:
  created: []
  modified:
    - packages/contracts/reorderListItems.ts
    - functions/src/reorderListItems.ts
    - functions/src/test/lists/reorderListItems.test.ts
    - apps/web/pages/admin/lists/[listId].tsx
    - apps/web/pages/admin/lists/[listId].test.ts
key-decisions:
  - "The reorder callable now accepts `rootListId` plus one `logicalItemOrder` payload for the whole chain and returns per-page assignments for local mirror sync."
  - "Cross-page row moves recreate media rows on the destination Subsplash list instead of reusing foreign list-row ids."
  - "The root detail page only enables save-order when the chain view is not read-only; healthy overflow chains may reorder, but diagnostics and mirror gaps still block mutation."
patterns-established:
  - "Whole-chain reorder validation compares the full synced logical payload against every remote media row before patching any Subsplash page."
  - "Frontend reorder persistence is factored through `persistListDetailsPageOrder` so mutation guards and post-success Firestore sync are testable without rendering the full page."
requirements-completed: [OFLOW-04, OFLOW-06]
duration: 13 min
completed: 2026-03-14
---

# Phase 06 Plan 05: Root-Aware Overflow Reorder Summary

**Root-detail reorder now targets the full logical overflow chain, repartitions remote Subsplash pages safely, and syncs Firestore mirrors from callable assignment output when mutation is allowed.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-03-14T21:28:41Z
- **Completed:** 2026-03-14T21:41:32Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Replaced the single-page reorder contract with a root-aware logical-chain contract and callable that validates chain health, locks every page in the chain, and repartitions media rows back into physical pages while preserving continuation links.
- Updated `/admin/lists/[listId]` to submit one logical reorder payload for the root chain, re-enable reorder on healthy overflow roots, and sync `lists/*/listItems` mirrors from the callable’s page assignments after remote success.
- Expanded the reorder regression suite with a multi-page overflow fixture and a blocked broken-chain case, and added a focused page-level regression proving mutation-blocked states never invoke the reorder callable.

## Task Commits

Atomic task commits were **not created** because local git metadata is not writable in this environment:

1. **Task 1: Replace single-page reorder semantics with a root-aware logical-chain contract** - not committed (`fatal: Unable to create '.git/index.lock': Operation not permitted`)
2. **Task 2: Wire root-detail save flow to the logical reorder contract and honor mutation blocking** - not committed (`fatal: Unable to create '.git/index.lock': Operation not permitted`)
3. **Task 3: Extend reorder regression tests for overflow repartitioning and blocked chains** - not committed (`fatal: Unable to create '.git/index.lock': Operation not permitted`)

**Plan metadata:** not committed for the same reason.

## Files Created/Modified

- `packages/contracts/reorderListItems.ts` - root-aware reorder contract plus callable assignment output for post-success mirror sync
- `functions/src/reorderListItems.ts` - chain-aware reorder callable with audit gating, chain-wide locking, repartitioning, and per-page assignments
- `functions/src/test/lists/reorderListItems.test.ts` - overflow repartition and blocked-chain regression coverage for the new callable contract
- `apps/web/pages/admin/lists/[listId].tsx` - root-detail reorder save orchestration, Firestore mirror sync, and healthy-overflow reorder enablement
- `apps/web/pages/admin/lists/[listId].test.ts` - page-level regression coverage for mutation-blocked reorder guards

## Decisions Made

- The reorder callable now owns page repartitioning and returns assignment metadata so the client can move mirrored `listItems` docs only after remote success.
- Healthy overflow roots are no longer forced into inspect-only mode; the detail page blocks reorder based on `chainView.isReadOnly` and `canSaveOrder`, not on the mere presence of overflow pages.
- Cross-page moves recreate media rows on the destination page instead of patching old list-row ids into a different Subsplash list.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Disabled Watchman for the focused page Jest run**
- **Found during:** Task 2 verification
- **Issue:** Jest crashed before running the page test because Watchman could not chmod its local state directory in this environment.
- **Fix:** Re-ran the focused page test with `--watchman=false` and `--runTestsByPath`.
- **Files modified:** none
- **Verification:** `pnpm --dir apps/web exec jest --config jest.config.js --runInBand --watchman=false --runTestsByPath '/Users/yasaad/Projects/upper-room-media/web-app/apps/web/pages/admin/lists/[listId].test.ts'`
- **Committed in:** not committed (local git writes blocked)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The deviation only affected how verification had to be invoked in this machine. The shipped code still follows the planned root-aware reorder approach.

## Issues Encountered

- Local git writes are blocked in this environment. Any `git add` or `git commit` attempt fails with `fatal: Unable to create '.git/index.lock': Operation not permitted`.
- The prescribed emulator-backed reorder verification cannot start here because localhost port binding returns `listen EPERM` for the Firebase emulator ports before any tests run.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Root-detail reorder now has the contract and persistence path needed for healthy overflow chains, and the client can keep Firestore mirrors aligned after remote success.
- This plan still needs to be rerun in an environment that allows `.git` writes and localhost emulator port binding before it can be considered fully finalized in GSD terms.

## Self-Check: FAILED

- `FOUND`: `.planning/phases/06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model/06-05-SUMMARY.md`
- `MISSING`: Task commit hashes (git metadata is not writable)
- `MISSING`: Final docs commit (same git write restriction)
- `MISSING`: Emulator verification run (localhost port binding returns `EPERM` before emulators start)

---
*Phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model*
*Completed: 2026-03-14*
