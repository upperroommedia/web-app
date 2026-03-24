---
phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model
plan: 06
subsystem: testing
tags: [firestore, backfill, overflow-chain, scripts, jest]
requires:
  - phase: 06-02
    provides: explicit overflow metadata fields, canonical overflow naming, and chain audit helpers
provides:
  - dry-run-safe legacy overflow metadata backfill flow
  - shared repair-plan derivation from audited overflow chains
  - regression coverage for dry-run, apply, and inconsistent-chain skip behavior
affects: [phase-06, list-admin, overflow-backfill, brownfield-repair]
tech-stack:
  added: []
  patterns: [functions-side repair helper with root script proxy, shared repair-plan derivation from chain audit output]
key-files:
  created:
    - functions/src/helpers/backfillListOverflowMetadata.ts
    - functions/src/test/lists/backfillListOverflowMetadata.test.ts
    - scripts/backfill-list-overflow-metadata.ts
  modified:
    - functions/src/helpers/listOverflowChain.ts
key-decisions:
  - "Keep the executable repair logic in `functions/src/helpers/backfillListOverflowMetadata.ts` and use the root script as a thin proxy so the plan's CLI command still works under the repo's mixed module setup."
  - "Repair plans only apply to chains with no blocking audit issues; inconsistent chains are surfaced and skipped instead of guessing fixes."
patterns-established:
  - "Overflow backfill flows derive writes from `getOverflowChainState` plus `buildOverflowChainRepairPlan`."
  - "Root scripts that need functions-source behavior can proxy into the functions package rather than importing mixed-module sources directly."
requirements-completed: [OFLOW-02, OFLOW-06]
duration: 15 min
completed: 2026-03-14
---

# Phase 06 Plan 06: Dry-Run Overflow Metadata Backfill Summary

**Dry-run/apply overflow metadata repair tooling with chain-derived write plans and explicit skip reporting for inconsistent legacy chains**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-14T21:08:00Z
- **Completed:** 2026-03-14T21:23:32Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Added a functions-side backfill helper that scans list docs, deduplicates logical roots, and derives repair writes from shared overflow-chain audit output.
- Added a root CLI proxy script so `pnpm exec ts-node --transpile-only scripts/backfill-list-overflow-metadata.ts ...` routes into the functions helper without duplicating repair logic.
- Added focused regression coverage for dry-run planning, apply-mode metadata repair, and inconsistent-chain skip behavior with issue output.

## Task Commits

Each task was intended to be committed atomically, but local Git writes are blocked in this environment.

1. **Task 1: Build a dry-run-safe list overflow metadata backfill tool** - not created (git index lock denied)
2. **Task 2: Add focused regression coverage for metadata repair and skip behavior** - not created (git index lock denied)

**Plan metadata:** not created (git index lock denied)

## Files Created/Modified
- `functions/src/helpers/backfillListOverflowMetadata.ts` - Repository repair helper with dry-run/apply modes, root-chain dedupe, skip reporting, and CLI entrypoint.
- `functions/src/helpers/listOverflowChain.ts` - Added repair-plan derivation and a blocking audit case for overflow-marked lists that cannot resolve a parent/root chain.
- `functions/src/test/lists/backfillListOverflowMetadata.test.ts` - Regression suite covering dry-run plans, apply writes, and inconsistent-chain skips.
- `scripts/backfill-list-overflow-metadata.ts` - Thin root-script proxy that forwards the documented CLI entrypoint into the functions helper.

## Decisions Made
- Moved the executable repair implementation into the functions package because the root `ts-node` path was loading functions sources as ESM and could not resolve the existing CommonJS-oriented helper graph reliably.
- Kept repair writes non-destructive: the tool only merges explicit metadata and canonical overflow names, and it skips chains with blocking audit issues.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Block overflow-flagged orphan lists from being treated as safe roots**
- **Found during:** Task 1
- **Issue:** A legacy list marked as overflow but missing a resolvable parent/root could have been treated as a repairable root.
- **Fix:** Added a blocking `CHAIN_ROOT_METADATA_CONFLICT` audit issue when an overflow-marked list cannot resolve a parent/root chain.
- **Files modified:** functions/src/helpers/listOverflowChain.ts
- **Verification:** TypeScript compile passed for the helper and new backfill flow.
- **Committed in:** not created (git index lock denied)

**2. [Rule 3 - Blocking] Proxy the root CLI command into the functions package**
- **Found during:** Task 1
- **Issue:** The plan's root `ts-node` command could not safely import the functions helper graph directly because of mixed ESM/CommonJS resolution.
- **Fix:** Added `functions/src/helpers/backfillListOverflowMetadata.ts` as the real implementation and made `scripts/backfill-list-overflow-metadata.ts` a thin proxy.
- **Files modified:** functions/src/helpers/backfillListOverflowMetadata.ts, scripts/backfill-list-overflow-metadata.ts
- **Verification:** `pnpm exec ts-node --transpile-only scripts/backfill-list-overflow-metadata.ts --help`
- **Committed in:** not created (git index lock denied)

---

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 3)
**Impact on plan:** Both deviations were required to keep the repair flow safe and executable without changing the plan's outward CLI contract.

## Issues Encountered
- `firebase emulators:exec` could not start in this environment because local emulator ports returned `EPERM`.
- Local Git writes are blocked here: creating `.git/index.lock` fails with `Operation not permitted`, so task commits and the final docs commit could not be created.
- The exact dry-run command reaches the helper entrypoint but hangs when attempting to talk to Firestore in this environment, so end-to-end dry-run verification was not completed here.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The repair tool, shared derivation logic, and regression suite are in place. Before treating this plan as complete, run the emulator-backed Jest suite plus the documented dry-run command in an environment that can start Firebase emulators, reach Firestore, and write Git commits.

## Self-Check: FAILED

- Missing commit records for both task commits and the final docs commit because `.git/index.lock` could not be created locally.
- Did not complete the plan's required end-to-end dry-run verification because the Firestore-backed command stalled in this environment after reaching the helper entrypoint.
