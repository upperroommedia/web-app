# 2026-04-06 Series Investigation

## Scope
- Issues investigated: `FIREBASE-FUNCTIONS-4`, `FIREBASE-FUNCTIONS-5`, `FIREBASE-FUNCTIONS-6`
- Callables: `addToSeries`, `removeFromSeries`, `reorderSeriesItems`
- Related flows: published vs unpublished sermon edits, remote delete behavior, and series membership sync

## What I Confirmed
- `FIREBASE-FUNCTIONS-5` and `FIREBASE-FUNCTIONS-6` were the malformed Subsplash PATCH failures.
- `FIREBASE-FUNCTIONS-4` was the downstream reorder guard rejecting a media item that no longer existed in the remote series.
- The deployed build that produced those failures was `addtoseries-00032-qeb`, `removefromseries-00033-yix`, and `reorderseriesitems-00033-soj`.

## Production Evidence
- At `2026-04-06T11:23:50.996Z`, `deletefromsubsplash` started deleting media item `39af5cb4-2b1b-4ce8-a338-61b0d668f4c3`.
- At `2026-04-06T11:24:01.760Z`, `seriesItemOnWrite` recalculated metadata for series `1637148e-4a5c-43cf-8ac8-7e91e4fbb327`.
- At `2026-04-06T11:25:57.317Z`, `reorderSeriesItems` failed with: `Cannot reorder media item 39af5cb4-2b1b-4ce8-a338-61b0d668f4c3; it does not exist in Subsplash series 1637148e-4a5c-43cf-8ac8-7e91e4fbb327.`
- At `2026-04-06T11:26:02.892Z`, `removeFromSeries` failed from `patchMediaItemSeries` with `bad_request` / `the request is invalid or malformed`.
- At `2026-04-06T11:43:44.468Z`, `addToSeries` failed with the same malformed Subsplash PATCH response.

## Root Cause
- The direct root cause for `FIREBASE-FUNCTIONS-5` and `FIREBASE-FUNCTIONS-6` was an incomplete media-item PATCH shape in the deployed build. The shared helper now sends the Subsplash `app_key` with the series membership PATCH, which matches the real client contract.
- The remaining series-specific behavior issue was semantic: `removeFromSeries` was treating an already-missing remote media item as a hard failure, even though the desired end state is simply “not in a series”.
- `reorderSeriesItems` should stay strict. If the remote membership hash no longer matches, or if the item is missing from the remote series, that means the caller is stale and should refresh before retrying.

## Fixes
- Shared Subsplash media-item PATCHes now include `app_key`.
- `removeFromSeries` now treats a missing remote media item as an idempotent no-op instead of throwing a fatal error.
- The series contract tests cover the PATCH shape and the remove-idempotency behavior.

## Published vs Unpublished Semantics
- A sermon can only be added to a series when it already has a Subsplash media item id.
- If the sermon is unpublished from Subsplash entirely, series membership cleanup should be treated as idempotent when the media item is already gone.
- Upload type affects how the media item is created (`youtubeUrl` vs file/audio upload), but once the media item exists the series membership patch shape is the same.
- Lists and series are separate publication channels. A list removal can delete the media item only when no published destinations remain; a series reorder should never be allowed to “paper over” missing remote membership.

## Verification
- `pnpm test` passed on the final state: `web-app` 32/32 suites and `functions` 74/74 suites.
- The new remove-idempotency behavior is covered in `functions/src/test/series/removeFromSeries.test.ts`.

## Notes
- The malformed PATCH work is already present in `d73d7e42`; this investigation focuses on the remaining remove/reorder semantics and the stale remote membership edge.
- I did not revert unrelated concurrent changes in the worktree.
