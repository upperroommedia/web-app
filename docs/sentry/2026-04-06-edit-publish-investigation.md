# 2026-04-06 Edit/Publish Investigation

## Scope

This investigation covered the overnight `firebase-functions` Sentry issues around sermon editing and publish-time remote patches, especially:

- `FIREBASE-FUNCTIONS-3` for `editSubsplashSermon`
- Related series membership issues in `addToSeries` / `removeFromSeries`

## What Was Observed

The relevant production failures all came from `POST /` callable edit/publish flows and were rooted in malformed remote requests rather than Firestore writes.

From Sentry and Cloud Logging:

- On `2026-04-06T11:26:42.426243Z`, `editSubsplashSermon` logged the exact outgoing PATCH body for `subsplashId=39af5cb4-2b1b-4ce8-a338-61b0d668f4c3`.
- That request body included `app_key`, `tags`, `title`, `summary`, `date`, and `_embedded.images`, but it also sent `subtitle: ""`.
- The same invocation failed with an Axios `400 Bad Request` at `2026-04-06T11:26:43.457385Z`, and the operational alert fired immediately after at `2026-04-06T11:26:43.505319Z`.
- A later successful `editSubsplashSermon` invocation on `2026-04-06T14:02:51.257018Z` and `2026-04-06T14:03:55.008954Z` used the same metadata-plus-images shape, but the subtitle was non-empty (`"Pascha Sermons"`). That is the production evidence that the field must not be blank on patch.
- The edit payload never included `audio` or `media-series` in `_embedded`; those nested resources are preserved by omission, not rewritten by this endpoint.
- `addToSeries` / `removeFromSeries` were patching `https://core.subsplash.com/media/v1/media-items/{id}` without `app_key`, and those calls also returned `400 Bad Request`.

## Root Cause

Two request-shape problems were present in the publish/edit path:

- Published sermon edits were forwarding a blank `subtitle` to Subsplash. The payload was otherwise valid, but Subsplash rejected the empty subtitle value.
- Series membership changes were missing `app_key` in the media-item PATCH payload. That made the request malformed even though the local Firestore bookkeeping was correct.

The surrounding publish logic itself was correct:

- Unpublished sermons stay local and do not call Subsplash or SoundCloud.
- Published sermons call the remote destination helpers only when they have the relevant remote IDs.
- YouTube-source and file-source edits still take the same sermon metadata path, while audio reprocessing remains gated separately.

## Fixes

Implemented in the shared helpers so the behavior is consistent everywhere:

- `editSubsplashSermon` now omits blank or whitespace-only `subtitle` values instead of sending `subtitle: ""`.
- `patchMediaItemSeries` now includes `app_key: "9XTSHD"` in the media-item PATCH payload.

## Verification

Validated with targeted emulator-backed tests:

- `functions/src/test/subsplash/editSubsplashSermon.locking.test.ts`
- `functions/src/test/series/seriesHelpers.requestShape.test.ts`
- `functions/src/test/series/addToSeries.test.ts`
- `functions/src/test/series/removeFromSeries.test.ts`

Those tests confirmed:

- blank subtitle fields are omitted from Subsplash edit payloads
- the edit payload keeps `_embedded.audio` and `_embedded['media-series']` out of the sermon metadata PATCH
- series PATCH payloads include `app_key`
- published vs unpublished branch behavior still works
- add/remove series flows still reconcile correctly

I also reviewed the SoundCloud edit path:

- `editSoundCloudSermon` already routes through `updateTrack`
- `updateTrack` already chooses JSON vs multipart based on artwork presence
- no SoundCloud patch-shape change was required for this issue family
