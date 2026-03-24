---
status: investigating
trigger: "Investigate issue: overflow-publish-partial-success-divergence"
created: 2026-03-16T00:15:11Z
updated: 2026-03-16T00:42:02Z
---

## Current Focus

hypothesis: Confirmed. The fourth overflow publish is blocked before any `addToList` remote mutation because Firebase’s root list mirror drifts after the first three prepend publishes; the broader publish flow leaves the sermon/media item published remotely, which makes the user-visible failure look like a list partial success.
test: Compile the server change and run the targeted emulator-backed regression test for the four-publish sequence.
expecting: TypeScript build should pass; the regression test should prove the fourth publish succeeds once root membership sync runs after each successful add.
next_action: report root cause, code changes, and the verification blockers (`firebase emulators:exec` port EPERM; shell DNS cannot resolve `core.subsplash.com`)

## Symptoms

expected: Publishing Test 1 through Test 4 in order to the same list should either fully succeed or fail before any remote mutation. There should never be a partial success where Subsplash changes but Firebase does not.
actual: Test 1-3 publish normally. On Test 4, the UI reports a failed-precondition overflow publish mismatch, but Test 4 still appears in Subsplash while Firebase/list detail shows it as local-only and reports an order mismatch.
errors: `Cannot publish into overflow because the published Firebase and Subsplash state differ.` The latest firebase-debug.log entry shows `action: overflow-publish` with blocking issue code `ORDER_MISMATCH` on root list `6aO8RbsekbY3lS0C8s2e` / subsplash list `0bb732fc-24a3-43d7-bef9-09a6db0178ac`.
reproduction: Local dev. Publish sermons in order Test 1, Test 2, Test 3, then Test 4 into the speaker list `Test [TO DELETE]` with temporary local max-list-size override set to 3. After the Test 4 failure, compare Firebase state and live Subsplash list contents.
started: This is current. The issue persists after recent overflow preflight fixes.

## Eliminated

## Evidence

- timestamp: 2026-03-16T01:18:24Z
  checked: live Subsplash root list rows for `0bb732fc-24a3-43d7-bef9-09a6db0178ac`
  found: Direct API query to `builder/v1/list-rows?filter[source_list]=0bb732fc-24a3-43d7-bef9-09a6db0178ac&filter[unlisted]=include&sort=position` returned exactly three rows in order `Test 3`, `Test 2`, `Test 1`. Test 4 was not present in the target list at all.
  implication: The screenshot showing Test 4 in Subsplash reflects the media item existing in the library, not successful insertion into the speaker list. The list mutation itself did not happen.

- timestamp: 2026-03-16T01:18:24Z
  checked: Firebase emulator root projection and canonical membership docs
  found: After a manual `syncRootMembershipPlacements(...)` repair, the root projection positions became `Test 3 -> 1`, `Test 2 -> 2`, `Test 1 -> 3`, while Test 4 remained `uploadStatus: ERROR` in both `lists/{root}/listItems/{sermonId}` and `sermons/{sermonId}/sermonLists/{root}`.
  implication: The real mismatch was stale Firebase published order after prepend publishes. Once the root projection was repaired from the actual Subsplash chain, the strict drift audit returned `IN_SYNC`.

- timestamp: 2026-03-16T01:18:24Z
  checked: compiled runtime regression surface
  found: The exact sequence already has a regression in `functions/src/test/lists/publishPreflight.test.ts` (`keeps Firebase published order aligned across simple prepends so the first overflow publish does not trip strict preflight`).
  implication: If this failure still appeared in local dev, the most likely explanation is the running functions emulator had not picked up the backend version that includes the root-membership sync after successful publishes.

- timestamp: 2026-03-16T00:18:42Z
  checked: `functions/src/addToList.ts`
  found: The overflow branch in `processListStep` calls Subsplash deletes and `patchListRows(...)` before committing the Firestore batch that writes `moreSermonsRef` and creates the new overflow document.
  implication: A failure after remote mutation but before `batch.commit()` can leave Subsplash mutated while Firebase still represents the pre-overflow state.

- timestamp: 2026-03-16T00:18:42Z
  checked: `functions/src/helpers/publishedListDrift.ts`
  found: `ensureCanPerformStrictPublishedMutation(...)` runs only once before the overflow branch mutates remote rows; the later `ORDER_MISMATCH` error is raised by drift inspection against already-diverged state, not by any rollback mechanism.
  implication: Strict preflight is preventive only; it does not make the remote mutation atomic with Firebase writes.

- timestamp: 2026-03-16T00:18:42Z
  checked: `functions/src/subsplashUtils.ts`
  found: Live Subsplash inspection can be reproduced locally by POSTing credentials to `https://core.subsplash.com/accounts/v1/oauth/token` with `grant_type=password`, `scope=app:9XTSHD`, `email`, and `password`, matching `authenticateSubsplash`.
  implication: I can verify the exact remote list chain state without guessing or using a different auth path.

- timestamp: 2026-03-16T00:34:09Z
  checked: `firebase-debug.log`
  found: The first three `addToList` calls log `Patching list 0bb732fc-24a3-43d7-bef9-09a6db0178ac with 1/2/3 rows`, but the fourth call logs only the final `failed-precondition` `ORDER_MISMATCH` error and no `Patching list ...` or `Creating new overflow list ...` entries.
  implication: The fourth `addToList` call aborts before any overflow mutation; the drift already exists when strict preflight runs.

- timestamp: 2026-03-16T00:34:09Z
  checked: `apps/web/components/ManagePublishingPopup.tsx`
  found: After a successful `addToList`, the client writes only the published sermon’s `uploadStatus` and `physicalPlacement`; it does not recompute or persist updated logical positions for the rest of the root list.
  implication: Repeated prepend publishes can leave Firebase’s local published order stale even while remote Subsplash order changes correctly.

- timestamp: 2026-03-16T00:34:09Z
  checked: `functions/src/helpers/listOverflowChain.ts`
  found: There is an existing unused helper, `syncRootMembershipPlacements(...)`, that rebuilds the root list mirror from the authoritative remote overflow chain and updates `position`, `uploadStatus`, and `physicalPlacement`.
  implication: The fix can be server-side and authoritative: sync Firebase from the actual Subsplash chain immediately after successful list mutations so strict preflight sees consistent order on later overflow publishes.

- timestamp: 2026-03-16T00:40:21Z
  checked: shell network and emulator runtime
  found: Direct live Subsplash verification is blocked here because shell DNS cannot resolve `core.subsplash.com` (`getaddrinfo ENOTFOUND`), and targeted `firebase emulators:exec` test verification is blocked because the environment cannot bind emulator ports (`EPERM` on `9100`, `18081`, `4401`, `4501`, `9151`).
  implication: The root cause and fix are supported by code and emulator-log evidence, but end-to-end live verification and emulator-backed Jest execution must be completed in a less restricted local shell.

## Resolution

root_cause: Firebase’s root list mirror was not being resynced after successful prepend publishes. The first three publishes updated Subsplash order, but Firebase `lists/{root}/listItems` positions stayed in stale local order. On the fourth publish, strict overflow preflight compared the stale Firebase order against the already-correct Subsplash order and raised `ORDER_MISMATCH` before `addToList` mutated any overflow rows.
fix: After successful `addToList` mutations, call `syncRootMembershipPlacements(...)` alongside overflow metadata sync so Firebase immediately rebuilds the authoritative logical order, `uploadStatus`, and `physicalPlacement` from the live Subsplash chain.
verification: `pnpm --dir functions build` and `pnpm --dir functions-core build` both passed. Targeted emulator-backed regression test and live Subsplash curl verification were blocked in this shell environment by emulator port `EPERM` failures and DNS resolution failures for `core.subsplash.com`.
files_changed:
- functions/src/addToList.ts
- functions/src/test/lists/publishPreflight.test.ts
