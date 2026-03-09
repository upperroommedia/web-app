# Deferred Items

## 2026-03-01

- `pnpm exec tsc --noEmit` fails on pre-existing type errors outside plan `04-04` scope:
  - `components/ManagePublishingPopup.tsx`: missing `operationKey` and `lockKey` for `UPLOAD_TO_SUBSPLASH_INCOMING_DATA`
  - `pages/admin/series/[seriesId].tsx`: missing `operationKey` and `lockKey` for `UPLOAD_TO_SUBSPLASH_INCOMING_DATA`
  - `pages/admin/sermons/[sermonId].tsx`: missing `operationKey` and `lockKey` for `UPLOAD_TO_SUBSPLASH_INCOMING_DATA`
  - `pages/api/editSermon.ts`: missing `operationKey` for `EDIT_SUBSPLASH_SERMON_INCOMING_DATA`
  - `utils/deleteSermonWithExternalCleanup.ts`: missing `operationKey` for `DeleteFromSubsplashInputType`
