---
phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model
plan: 01
subsystem: api
tags: [firebase-functions, firestore, list-overflow, contracts, testing]
requires:
  - phase: 05-speaker-management-crud-admin-create-speaker-popup-with-optional-speaker-list-association
    provides: callable/test wiring and current admin list data model
provides:
  - explicit optional root/overflow metadata on shared and app list contracts
  - typed getListOverflowChain callable contract for normalized chain reads
  - server-owned overflow chain helper with legacy fallback inference and issue reporting
  - focused chain read tests for explicit metadata, legacy inference, and broken-chain blocking
affects: [admin-lists, add-to-list, reorder-list-items, delete-subsplash-list]
tech-stack:
  added: []
  patterns: [explicit root-chain metadata, callable-backed chain audit read model, legacy metadata fallback]
key-files:
  created:
    - packages/contracts/getListOverflowChain.ts
    - functions/src/helpers/listOverflowChain.ts
    - functions/src/getListOverflowChain.ts
    - functions/src/test/lists/getListOverflowChain.contract.ts
    - functions/src/test/lists/getListOverflowChain.test.ts
  modified:
    - packages/shared/types/List.ts
    - apps/web/types/List.ts
    - functions/src/index.ts
key-decisions:
  - "List contracts now carry explicit optional isRootList/rootListId/overflowDepth metadata while preserving legacy isMoreSermonsList/moreSermonsRef compatibility."
  - "The new getlistoverflowchain callable resolves chain state through a shared server helper and returns stable machine-readable issue codes plus canMutate gating."
patterns-established:
  - "Chain reads prefer explicit metadata first and fall back to parent-link inference by moreSermonsRef when brownfield documents are missing root metadata."
  - "Admin list safety should key off blocking issue severities from the normalized chain response instead of inferring action availability client-side."
requirements-completed: [OFLOW-03, OFLOW-04]
duration: 8 min
completed: 2026-03-14
---

# Phase 06 Plan 01: Define explicit root/overflow metadata and add the shared chain-audit callable Summary

**Explicit root/overflow list metadata plus a typed getlistoverflowchain read model for normalized chain state, logical totals, and mutation-safe integrity issues**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-14T20:36:18Z
- **Completed:** 2026-03-14T20:45:08Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Extended both list type definitions with explicit root/overflow metadata fields and root-only logical total flags while keeping legacy fields available.
- Added a typed overflow-chain contract and a shared Firebase Functions helper that resolves roots, computes logical counts, and emits stable blocking/warning issues.
- Added focused chain-read tests covering explicit metadata, legacy parent-link inference, direct root input, and broken-chain mutation blocking.

## Task Commits

Local task commits were not created because this environment cannot write inside `.git` (`.git/index.lock` creation fails with `Operation not permitted`).

## Files Created/Modified
- `packages/shared/types/List.ts` - Added optional root-chain metadata fields and logical total defaults to the shared list contract.
- `apps/web/types/List.ts` - Kept app-side list typing in lockstep with the shared root/overflow contract.
- `packages/contracts/getListOverflowChain.ts` - Defined typed input/output, nodes, and stable issue-code enums for the new callable.
- `functions/src/helpers/listOverflowChain.ts` - Implemented root resolution, legacy fallback traversal, canonical-name checks, and blocking issue generation.
- `functions/src/getListOverflowChain.ts` - Added the publisher/admin-gated callable wrapper around the shared helper.
- `functions/src/index.ts` - Exported `getlistoverflowchain` with the lower-case callable key required by v2 routing.
- `functions/src/test/lists/getListOverflowChain.contract.ts` - Added compile-time parity checks for shared/app list contracts and callable types.
- `functions/src/test/lists/getListOverflowChain.test.ts` - Added runtime-focused tests for explicit, legacy, root-input, and broken-chain cases.

## Decisions Made
- Used optional root metadata fields instead of making them mandatory immediately so brownfield documents remain readable during migration/backfill.
- Normalized chain issues into stable codes plus severities so later admin surfaces can gate delete/reorder behavior without duplicating integrity logic.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Functions workspace could not resolve the new contracts package subpath**
- **Found during:** Task 1 (Define explicit root/overflow metadata and chain-state contracts)
- **Issue:** `functions` does not declare `@upperroom/contracts` as a dependency, so the compile-time contract spec could not import the new subpath by package name.
- **Fix:** Pointed the functions-side typecheck file at the local workspace path while keeping the real published contract in `packages/contracts/getListOverflowChain.ts`.
- **Files modified:** `functions/src/test/lists/getListOverflowChain.contract.ts`
- **Verification:** `pnpm --dir functions exec tsc --noEmit`
- **Committed in:** Not committed; local git metadata is read-only in this environment.

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope creep. The deviation only adjusted local typecheck wiring in the functions workspace.

## Issues Encountered
- Firebase emulator verification is blocked in this environment because local port binding fails with `listen EPERM` on the configured auth/firestore/database ports, so the new Jest emulator suite was written but not executed here.
- Local git commits are blocked because writing `.git/index.lock` fails with `Operation not permitted`, so the required per-task commits and final metadata commit could not be created.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- The chain contract, helper, callable export, and test scaffolding are in place for Phase 06 plan 02 to start persisting canonical metadata on write paths.
- Before marking this plan complete in GSD state, rerun the emulator suite in an environment that can bind local ports and restore `.git` write access so task commits and metadata commits can be recorded accurately.

## Self-Check: FAILED

- Missing local task commits because `.git/index.lock` cannot be created in this environment.
- Missing final metadata commit for the same reason.
- Emulator verification command could not run because Firebase emulators could not bind localhost ports (`EPERM`).

---
*Phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model*
*Completed: 2026-03-14*
