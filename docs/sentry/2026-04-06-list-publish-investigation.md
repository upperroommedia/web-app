# 2026-04-06 List Publish / Add Investigation

## Scope

This investigation covered the overnight `firebase-functions` Sentry issue family centered on `FIREBASE-FUNCTIONS-2`, which reported add-to-list failures of the form:

- `Added item <mediaItemId> could not be resolved in list <listId> after patch.`

The reviewed code paths were:

- `functions/src/addToList.ts`
- `functions/src/helpers/addToListHelpers.ts`
- `functions/src/test/addToList/**`

I also cross-checked Cloud Logging around the Sentry event window so the investigation was grounded in production evidence, not only the emulator.

## What The Logs Showed

The production `addtolist` logs around the Sentry window showed active list patching on the same lists that appeared in the issue family:

- At `2026-04-06T11:25:25.023322Z`, `addToList` logged the remote state for list `3ebb4548-838d-46d5-8f03-9aba7bc1f717` with `currentRows.total=198`.
- The same execution then logged `Patching list 3ebb4548-838d-46d5-8f03-9aba7bc1f717 with 198 rows` at `2026-04-06T11:25:25.594482Z`, then `199 rows` at `2026-04-06T11:25:26.629399Z`.
- On a later execution for list `7b7d3fc9-8600-4ec0-b3d1-eed79c0a2ac6`, the function logged `Patching list ... with 197 rows` at `2026-04-06T11:32:08.660429Z`, then `198 rows` at `2026-04-06T11:32:10.115716Z`, and the request failed with Subsplash `400`.
- The same list produced another failure window at `2026-04-06T11:43:04.792270Z` through `2026-04-06T11:43:07.683384Z`, again showing patch attempts followed by a Subsplash `400`.

Concrete log evidence:

- `3ebb4548-838d-46d5-8f03-9aba7bc1f717` at `11:25:25Z` to `11:25:26Z`
- `7b7d3fc9-8600-4ec0-b3d1-eed79c0a2ac6` at `11:32:08Z` to `11:32:10Z`
- `7b7d3fc9-8600-4ec0-b3d1-eed79c0a2ac6` again at `11:43:04Z` to `11:43:07Z`

That is the mismatch pattern we care about: the function had already prepared a patch, but the post-patch state was not stable enough to rely on a single short lookup window.

## Root Cause

The `addToList` code already retries post-patch row resolution, but the window was too short for production. Both resolution paths only waited about one second total:

- `resolveListItemIdWithRetry`
- `findItemInOverflowChainWithRetry`

That was enough for the emulator and most happy paths, but not for the slower real-world list mutations that showed up in Sentry. When Subsplash returned a patch response without an immediately discoverable row ID, the function could exhaust its short retry window before the new row became visible in `list-rows`.

I also verified the list patch payload shape itself was not the primary issue in this family:

- shared Subsplash list patches already include `list_rows_count`
- the failure here is downstream of the patch, during row identity resolution

## Code Changes

Implemented in the shared add-to-list path:

- `functions/src/addToList.ts`
  - extended the post-patch lookup schedule to a longer shared retry window
  - applied the same schedule to both direct row resolution and overflow-chain resolution
- `functions/src/test/addToList/mocks.ts`
  - added a stale patch-response mode so the test can simulate a patch response that does not immediately expose the new row ID
- `functions/src/test/addToList/postPatchRowIdentity.test.ts`
  - added a regression that forces a stale patch response plus delayed row visibility, then verifies the new retry window recovers correctly

## Test Evidence

Focused regression run:

- `pnpm --dir functions exec firebase emulators:exec --only auth,firestore,database,storage --config ../firebase.test.json "pnpm exec jest --watchman=false --runInBand --forceExit src/test/addToList/postPatchRowIdentity.test.ts"`

Result:

- `PASS src/test/addToList/postPatchRowIdentity.test.ts`
- `4 passed, 4 total`

## Residual Risks

- The production logs also show Subsplash `400` responses on large list patch attempts. I did not change the patch semantics in this pass because the evidence I had was strongest for the post-patch resolution gap, not a malformed payload.
- If the remaining `400` failures continue after this retry hardening is deployed, the next step is to inspect the exact upstream Subsplash rejection body for those executions and decide whether list trimming, patch shape, or a concurrency guard needs to change.

