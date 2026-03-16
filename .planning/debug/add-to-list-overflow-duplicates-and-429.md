---
status: investigating
trigger: "Investigate issue: add-to-list-overflow-duplicates-and-429"
created: 2026-03-14T00:00:00-07:00
updated: 2026-03-15T11:38:00-07:00
---

## Current Focus

hypothesis: The codebase already contains a local patch that neutralizes the old `listItemOnDelete` auto-cascade. If the Test 2/Test 3 repro still happens, either the running environment is still executing the old listener code or a different writer is deleting the root `listItems`/`sermonLists` docs before `sermonListOnDelete` performs its own automatic Subsplash removal.
test: Treat the old `listItemOnDelete` cascade as the first identified illegal delete, but verify current-tree behavior from source and diff. Then instrument the remaining delete entry points so the initiating writer can be distinguished from trigger fallout.
expecting: The notebook should show two truths at once: the original first illegal delete was the auto-cascade in `listItemOnDelete`, and the current worktree has already removed that local delete. The remaining fix is to add explicit delete intent around any `sermonLists` removal and surface drift on the list detail page.
next_action: Add targeted coverage and instrumentation for delete provenance on root `listItems`/`sermonLists`, then intent-gate `sermonListOnDelete` and any explicit admin remove flow.

## Symptoms

expected: Adding a sermon to a full list should create or use the correct overflow list, move the correct rows exactly once, and never create duplicate sermon rows in Subsplash.
actual: When testing overflow creation, Subsplash shows duplicate rows (user specifically saw two copies of Sermon 4), and the function eventually logs `Request failed with status code 429` from addToList.
errors: Primary error is Axios 429 from addToList. Follow-on operational alert log is noise from handleError/emitOperationalAlert. User notes maxListSize was temporarily reduced from 200 to 5 only to trigger overflow behavior quickly.
reproduction: Fill a list until overflow triggers with maxListSize=5, then add enough items to create overflow pages. Observe Subsplash state and function logs.
started: Appeared while actively testing newly implemented Phase 06 overflow behavior. Need to determine whether the duplicate rows come from incorrect move/patch logic, transaction/replay behavior, recursive propagation bugs, or another backend flaw before considering retry logic.

## Eliminated

- hypothesis: The current worktree still auto-deletes `sermons/{sermonId}/sermonLists/{listId}` from `listItemOnDelete`.
  evidence: `functions/src/DocumentListeners/Lists/listItemOnDelete.ts` now only logs `listItemOnDelete.autoCascadeSkipped` for root lists and no longer calls `transaction.delete(sermonListRef)`.
  timestamp: 2026-03-15T11:36:00-07:00

## Evidence

- timestamp: 2026-03-14T00:06:00-07:00
  checked: functions/src/addToList.ts
  found: processListStep performs getFullListRowsWithTotal, createNewList, DELETE list-row calls, and patchListRows inside firestoreDB.runTransaction.
  implication: Firestore transaction replay can repeat external Subsplash side effects because they are not transactionally rolled back.
- timestamp: 2026-03-14T00:08:00-07:00
  checked: functions/src/helpers/addToListHelpers.ts
  found: patchListRows itself performs an additional GET list details call and then PATCHes the full row payload each time it is invoked.
  implication: Each overflow step is network-heavy; repeated execution would amplify request volume and can plausibly surface as 429.
- timestamp: 2026-03-14T00:09:00-07:00
  checked: functions/src/helpers/listOverflowChain.ts
  found: syncOverflowChainMetadata updates Firestore metadata and may patch parent rows only when collapsing empty tail pages; it does not create duplicate media rows.
  implication: metadata sync is likely responsible for extra traffic, not the observed duplicate sermon rows.
- timestamp: 2026-03-14T00:10:00-07:00
  checked: functions/src/test/addToList/*.test.ts
  found: existing tests cover page numbering, isolation, and older retry bugs, but none assert against duplicate external overflow mutations under replay with maxListSize=5 style multi-page propagation.
  implication: the current suite can miss the exact production failure mode the user described.
- timestamp: 2026-03-14T00:18:00-07:00
  checked: user-reported behavior for sermons 4 and 5
  found: remote publish/list state in Subsplash advanced further than Firestore for later sermons, and the speaker list only reflects the earliest items.
  implication: the failure is not a clean rollback; addToList is likely producing partial remote success while the local mirror/update path records failure or never commits the corresponding Firestore state.
- timestamp: 2026-03-14T00:24:00-07:00
  checked: apps/web/pages/admin/sermons/[sermonId].tsx, apps/web/components/ManagePublishingPopup.tsx, functions/src/DocumentListeners/SermonLists/*.ts
  found: Firestore publish/list mirror updates depend on addToList returning success/error statuses; there is no later reconciliation from Subsplash if addToList partially succeeds remotely and reports failure.
  implication: any partial remote success inside addToList directly explains why sermons can look published in Subsplash while Firestore remains stale for sermon/list upload state.
- timestamp: 2026-03-14T23:35:00-07:00
  checked: functions/src/test/addToList/postPatchRowIdentity.test.ts
  found: A mock mode that returns the pre-patch root rows once after a successful overflow patch reproduces the production error exactly: `Value for argument "data" is not a valid Firestore document... result.\`0\`.listItemId`.
  implication: The function was treating a stale post-patch refetch as authoritative for the newly added row id, which poisoned the idempotency write even though the remote mutation had already succeeded.
- timestamp: 2026-03-14T23:42:00-07:00
  checked: functions/src/helpers/addToListHelpers.ts, functions/src/addToList.ts
  found: `patchListRows()` can return the patched row set from Subsplash, so `processListStep()` does not need to refetch immediately to discover the new row id.
  implication: Row identity can be resolved from the mutation response itself, which is both more robust and one fewer network round trip on the critical path.
- timestamp: 2026-03-15T00:12:00-07:00
  checked: apps/web/components/ManagePublishingPopup.tsx, apps/web/pages/admin/sermons/[sermonId].tsx
  found: both admin publish UIs persist `sermons/{sermonId}/sermonLists/{listId}.uploadStatus.listItemId` and `lists/{listId}/listItems/{sermonId}.physicalPlacement` only for the logical root list that the user selected, always with `overflowDepth: 0` and the root `subsplashListId`.
  implication: once overflow pushes a sermon into a child Subsplash list, the app loses the real physical placement and later remove/republish flows will still target the root list row id they first recorded.
- timestamp: 2026-03-15T00:14:00-07:00
  checked: functions/src/addToList.ts, functions/src/helpers/listOverflowChain.ts
  found: `processListStep()` recursively propagates overflow items into child lists and can move existing sermons across physical lists, but the callable only returns one `{ listId, listItemId }` pair per requested destination list and never reports the downstream relocation of other sermons.
  implication: overflow side effects on previously published sermons are invisible to Firestore, so subsequent mutations can operate on stale row ids and stale physical list ids for shared lists.
- timestamp: 2026-03-15T00:24:00-07:00
  checked: functions/src/removeFromList.ts
  found: removal first DELETEs the stored `listItemId` directly and only searches overflow pages when that delete returns 404/400. It never verifies that the deleted row still belongs to the requested `itemId`, and for many non-404 failures it returns a success payload with `itemNotFound: true`.
  implication: if Firestore/UI is holding stale placement data, `removeFromList` can report success without proving it removed the correct sermon from the logical list.
- timestamp: 2026-03-15T00:26:00-07:00
  checked: functions/src/DocumentListeners/Lists/listItemOnCreate.ts, functions/src/DocumentListeners/Lists/listItemOnDelete.ts, apps/web/pages/api/editSermon.ts
  found: logical membership is driven by `lists/{listId}/listItems/{sermonId}` plus listeners that create/delete `sermons/{sermonId}/sermonLists/{listId}`. `editSermon` also deletes those root list-item docs when a sermon's canonical list set changes.
  implication: logical membership and physical placement share the same Firestore document surface, so any sync code that mistakes a physical overflow move for a logical membership delete can remove list membership from other sermons.
- timestamp: 2026-03-15T11:08:00-07:00
  checked: apps/web/components/ManagePublishingPopup.tsx, apps/web/pages/admin/sermons/[sermonId].tsx, apps/web/pages/api/editSermon.ts
  found: publish flows themselves only `set` the target sermon's `sermonLists/{listId}` and `lists/{listId}/listItems/{sermonId}` docs. The only normal app-side path that still directly deletes `lists/{listId}/listItems/{sermonId}` is `editSermon.ts`.
  implication: if shared-list membership disappears immediately after publish, either an implicit edit path is firing or a backend-side delete initiator still exists. Removing `editSermon` auto-deletes is the highest-signal way to separate those cases.
- timestamp: 2026-03-15T11:12:00-07:00
  checked: functions/src/helpers/listItemMirrorSync.ts, functions/src/addToList.ts, functions/src/removeFromList.ts
  found: automatic `listItemMirrorSync` calls are already removed from add/remove. `syncOverflowChainMetadata` still runs, but it updates list metadata and collapse-empty-tail links; it does not directly delete local `lists/{listId}/listItems/{sermonId}` docs.
  implication: the current recurring local membership deletes are not caused by the old mirror-sync path that the user already rejected.
- timestamp: 2026-03-15T11:26:00-07:00
  checked: apps/web/pages/api/editSermon.ts, apps/web/tests/utils/editSermon.test.ts
  found: `editSermon.ts` in the current worktree already stopped deleting `lists/{listId}/listItems/{sermonId}` and now only logs `editSermon.listMembershipDriftDetected` when Firebase membership diverges from canonical list resolution. Its tests explicitly assert no auto-delete happens for stale Firebase list memberships.
  implication: the current Test 2/Test 3 repro is no longer explained by ordinary Edit Sermon diff logic alone; the remaining delete must come from a different writer or from trigger fallout after a root list-item delete.
- timestamp: 2026-03-15T11:28:00-07:00
  checked: code search across `apps/web` and `functions/src` for production deletes on `lists/*/listItems/*` and `sermons/*/sermonLists/*`
  found: outside sermon/series hard-deletes, the only remaining production delete path on local list membership surfaces is `listItemOnDelete` deleting `sermons/{sermonId}/sermonLists/{listId}` after a root `listItems` delete. `sermonListOnDelete` then escalates that fallout by calling `removeFromList` in Subsplash when the deleted sermon-list doc was marked uploaded.
  implication: the local shared-list loss is now concentrated in the listener cascade rather than scattered ordinary app code. Distinguishing the initiating delete writer from fallout is necessary, but the first automatic destructive step is already isolated.
- timestamp: 2026-03-15T11:30:00-07:00
  checked: functions/src/DocumentListeners/Lists/listItemOnDelete.ts, functions/src/DocumentListeners/SermonLists/sermonListOnDelete.ts
  found: `listItemOnDelete` unconditionally deletes the mirrored `sermonLists/{listId}` doc for root lists without checking delete provenance, explicit admin intent, or Firebase/Subsplash drift state. `sermonListOnDelete` then treats the missing sermon-list doc as authority to remove from Subsplash if upload metadata exists.
  implication: this is the first illegal delete in the cascade under the user's policy. A single stray root `listItems` delete is amplified into local membership loss and possibly remote removal, even though the system is supposed to surface divergence for explicit admin resolution instead of auto-deleting.
- timestamp: 2026-03-15T11:31:00-07:00
  checked: functions/src/test directory
  found: there is no existing regression coverage for the `listItemOnDelete` -> `sermonListOnDelete` cascade or for enforcing explicit delete intent on shared list membership.
  implication: the delete boundary that matters most to the current repro is untested, which is why policy-violating automatic deletes could survive earlier fixes.
- timestamp: 2026-03-15T11:36:00-07:00
  checked: current worktree for `functions/src/DocumentListeners/Lists/listItemOnDelete.ts`
  found: the file is already patched locally. For root lists it now logs `listItemOnDelete.autoCascadeSkipped` and returns, instead of deleting `sermons/{sermonId}/sermonLists/{listId}` or decrementing counts.
  implication: the first illegal delete has already been removed in the local codebase, but the notebook must still record it as the original failure mode. If the repro persists, either the runtime is not using this patch yet or a different initiating writer is deleting membership docs before `sermonListOnDelete` runs.
- timestamp: 2026-03-15T11:37:00-07:00
  checked: current worktree for `functions/src/DocumentListeners/SermonLists/sermonListOnDelete.ts`
  found: `sermonListOnDelete` still automatically calls `removeFromList` in Subsplash whenever a deleted `sermonLists/{listId}` doc had `uploadStatus.status === 'UPLOADED'`, and it does so without verifying explicit admin delete intent.
  implication: even after neutralizing `listItemOnDelete`, any unintended `sermonLists` delete still causes policy-violating remote fallout. The right fix must guard this listener with explicit delete provenance rather than trusting deletion alone.

## Resolution

root_cause: The prior stale-row-id bug was real and fixed, but it was not the only failure mode. The first identified illegal delete in this investigation was the old `listItemOnDelete` auto-cascade that deleted `sermons/{sermonId}/sermonLists/{listId}` whenever a root `lists/{listId}/listItems/{sermonId}` doc disappeared. The current worktree already contains a local patch that removes that delete, and `editSermon.ts` is additive-only as well. What remains unresolved is the initiating writer that still removes membership docs in the user's repro, plus `sermonListOnDelete` automatically removing from Subsplash on any uploaded `sermonLists` deletion even when delete provenance is unknown.
fix: Keep the local `listItemOnDelete` neutralization, then extend the same policy to `sermonListOnDelete` and any explicit admin remove flow by introducing explicit delete intent/provenance. Only verified admin remove actions should delete membership locally or in Subsplash; all other Firebase/Subsplash divergence should be surfaced on the list detail page for manual resolution. Add targeted regression coverage for both the skipped auto-cascade and the intent-gated delete path before further flow hardening.
verification: Pending.
files_changed:
- functions/src/addToList.ts
- functions/src/helpers/addToListHelpers.ts
- functions/src/test/addToList/mocks.ts
- functions/src/test/addToList/postPatchRowIdentity.test.ts
- functions/src/DocumentListeners/Lists/listItemOnDelete.ts
- apps/web/pages/api/editSermon.ts
- apps/web/tests/utils/editSermon.test.ts
- .planning/debug/add-to-list-overflow-duplicates-and-429.md

## 2026-03-15 Cross-Boundary Reorder Investigation
- user repro: cross-boundary reorder with local `DEFAULT_MAX_LIST_SIZE = 3` leaves root physical list with 3 media + overflow link and pushes overflow link out of last position; overflow page ends with extra media rows.
- log evidence: `reorderlistitems` patched root Subsplash list `74513ffc-7dd5-48f0-9690-e2a6420fe909` with 3 rows and overflow list `e045e9dc-d21a-464f-9148-c4f3b5df99d1` with 2 rows during the failing reorder window (`2026-03-16T02:29:24Z` and `02:29:55Z`).
- firestore evidence: root projection `lists/HSUHJ5QSeJH9X2fP7Lno/listItems` says the logical order is four unique sermons with physical placement split 2 on root and 2 on overflow, which is internally consistent with the dev max-3 rule. Root/overflow list docs have stale `count` metadata (`3` and `2`), so doc-level counts are not trustworthy for physical truth.
- live Subsplash evidence: direct API query to `core.subsplash.com/builder/v1/list-rows` shows the root physical list contains `Test 1`, `Test 3`, the overflow link, and then `Test 4`; the overflow list contains `Test 4`, `Test 2`, `Test 1`. That means rows are being retained across pages, causing duplicates and the link to land second-to-last.
- root cause: `reorderListItems` assumed `PATCH /builder/v1/lists/{id}` would remove rows omitted from `_embedded.list-rows`. Real Subsplash behavior retains omitted rows after the payload rows. `addToList` already compensates for this by explicitly deleting propagated rows before patching; `reorderListItems` did not, so cross-boundary reorder left old rows behind and duplicated sermons across root/overflow pages.
- fix direction: before patching each physical page during reorder, explicitly delete any existing row that is not present in that page's target row set. Tests must simulate the real non-destructive PATCH behavior so this cannot regress.

## 2026-03-15 Hot-Reload / FieldValue.delete Investigation

Symptoms:
- After editing a function during local dev, a later `addtolist` publish failed with `Cannot read properties of undefined (reading 'delete')`.

Findings:
- The live emulator log pointed to `functions-core/lib/functions/src/addToList.js` catching an error thrown from overflow metadata maintenance.
- The actual failing path was `addToList -> syncOverflowChainMetadata -> collapseEmptyTailOverflowPages -> update({ moreSermonsRef: ...delete() })`.
- This was not just a generic hot-reload failure. The helper used `firebaseAdmin.firestore.FieldValue.delete()` in runtime overflow/drift code.
- We replaced those runtime uses with direct `FieldValue` imports from `firebase-admin/firestore` in:
  - `functions/src/helpers/listOverflowChain.ts`
  - `functions/src/helpers/publishedListDrift.ts`
  - `functions/src/soundcloudSecrets.ts`
- Regression coverage was added in `functions/src/test/lists/overflowChainEndToEnd.test.ts` for collapsing an empty tail overflow page.

Related dev-tooling issue discovered:
- `pnpm run build-functions-codebases` was replaying cached Turbo builds even when `functions/src/**` changed, because the split functions packages do not express that shared source tree in Turbo's dependency graph.
- For now, dev-facing function builds were switched to `--force` so startup/build paths cannot hand the emulator stale compiled bundles.

## 2026-03-15 Structured List Debug Trace

Added shared structured debug logging in `functions/src/helpers/listDebugLogger.ts` and wired it into the currently exercised list paths:
- `addToList`
- `removeFromList`
- `reorderListItems`
- `listOverflowChain` sync/audit helpers
- `publishedListDrift` audit/strict-preflight/resolve helpers
- `getListPublishedDrift` / `resolveListPublishedDrift` callables

Emulator logs now emit `[list-debug] <event>` entries with summarized row state, chain state, assignments, mismatch issues, and branch decisions.

Key event families:
- `addToList.*`
- `removeFromList.*`
- `reorderListItems.*`
- `listOverflowChain.*`
- `publishedListDrift.*`
- `getListPublishedDrift.*`
- `resolveListPublishedDrift.*`

Verified after instrumentation:
- `pnpm --dir functions build`
- `pnpm run build-functions-codebases`
- emulator-backed `overflowChainEndToEnd` + `publishPreflight` suites still pass
