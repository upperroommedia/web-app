# Integrations Mapping (Tech Focus)

## Core Platform Providers

### Firebase (Primary Backend)

- Client SDK bootstraps in `firebase/firebase.ts` with project `urm-app` and hardcoded config values.
- Firestore client connection lives in `firebase/firestore.ts` with emulator switching for development.
- Auth client lives in `firebase/auth.ts` (Google/Apple/Microsoft sign-in consumed in `context/user/UserContext.tsx`).
- Functions client and emulator routing are in `firebase/functions.ts` and `utils/createFunction.ts`.
- Realtime Database client is wired in `firebase/database.ts` and used by bundle metadata + task progress reads.
- Storage clients are in `firebase/storage.ts` (`storage` and secondary bucket `imageStorage`).

### Firebase Admin / Server Access

- Admin SDK bootstrap is in `firebase/firebaseAdmin.ts` for functions and SSR token checks.
- SSR protected route token verification uses admin auth in `components/ProtectedRoute.tsx`.
- User role management and admin listing flows use callable functions in `functions/src/setUserRole.ts`, `functions/src/listUsers.ts`, `functions/src/getUser.ts`.

## External APIs and Services

### Subsplash API (Content and Publishing Backbone)

- Authentication uses OAuth password grant against `https://core.subsplash.com/accounts/v1/oauth/token` in `functions/src/subsplashUtils.ts`.
- Media publish/edit/delete calls are in:
- `functions/src/uploadToSubsplash.ts`
- `functions/src/editSubsplashSermon.ts`
- `functions/src/deleteFromSubsplash.ts`
- List management is integrated via:
- `functions/src/createNewSubsplashList.ts`
- `functions/src/editSubsplashList.ts`
- `functions/src/deleteSubsplashList.ts`
- Series lifecycle integrates with Subsplash Media Series APIs in `functions/src/helpers/seriesHelpers.ts` and callers (`createSeries.ts`, `addToSeries.ts`, `removeFromSeries.ts`, `reorderSeriesItems.ts`, `deleteSeries.ts`).
- Image upload pipeline requests Subsplash file slots then uploads via presigned URL in `functions/src/handleImageUpload.ts`.

### SoundCloud API

- Upload/update/delete helpers are centralized in `functions/src/soundcloudClient.ts` (`https://api.soundcloud.com`).
- Callable wrappers with role checks and secret usage are in:
- `functions/src/uploadToSoundCloud.ts`
- `functions/src/editSoundCloudSermon.ts`
- `functions/src/deleteFromSoundCloud.ts`
- Secret is managed via Functions param `defineSecret('SOUNDCLOUD_CLIENT_SECRET')` in `functions/src/soundcloudSecrets.ts`.

### Algolia Search

- Client-side direct search is used for indices `sermons`, `speakers`, `lists`, and `images` in:
- `components/SearchableAdminSermonsList.tsx`
- `components/uploaderComponents/SpeakerSelector.tsx`
- `components/ListSelector.tsx`
- `components/ImageSelector.tsx`
- `pages/admin/lists.tsx`
- Secure API key generation for uploader scoping is exposed by callable `generatesecuredapikey` in `functions/src/generateAlgoliaSecureApiKey.ts`.
- Development can bypass Algolia with a Firestore-backed mock client in `utils/mockAlgoliaSearchClient.ts`.

### Dolby API

- OAuth client credential token call uses `https://api.dolby.io/v1/auth/token` in `functions/src/Dolby/getDolbyToken.ts`.
- Transcode API call uses `https://api.dolby.com/media/transcode` in `functions/src/Dolby/transcodeAudio.ts`.
- Env deps are `DOLBY_API_KEY` and `DOLBY_API_SECRET` (from code usage).

### YouTube Integration

- Browser playback/editing uses YouTube IFrame API in `components/trimmer/youtubeIframeAdapter.ts`.
- Upload pipeline can accept YouTube URLs and queue server-side processing in `pages/api/uploadFile.tsx` + `functions/src/addIntroOutro/*`.
- A separate Cloud Run service for YouTube-to-MP3 exists in `youtube-to-mp3-cloud-run/index.js`.

### Google Cloud Run / Tasks

- Function URL routing for v2 callable-by-URL pattern uses `*.a.run.app` hosts in `utils/createFunction.ts`.
- Audio processing dispatches to Cloud Tasks queue `addintrooutrotaskhandler` in `functions/src/addIntroOutro/addintrooutrotaskgenerator.ts`.
- Generator targets `https://process-audio-yshbijirxq-uc.a.run.app/process-audio` in production and local `http://127.0.0.1:8080/process-audio` in emulator mode.

## Storage, Media, and Bundle Integrations

### Cloud Storage

- Primary bucket usage via Admin SDK default bucket (`urm-app.appspot.com`) appears in upload and media processing functions.
- Secondary bucket `urm-app-images` is explicitly used for image ingestion in `firebase/storage.ts` and `functions/src/handleImageUpload.ts`.
- Audio path conventions are in `constants/storage_constants.ts` (`sermons`, `processed-sermons`, `intro-outro-sermons`).

### Firestore Bundles + Realtime Metadata

- Bundle definitions and metadata paths are in `shared/bundleConfigs.ts`.
- Bundle binaries are written to Cloud Storage paths like `bundles/topics-bundle.bin` by `functions/src/utils/bundleCreationUtils.ts`.
- Metadata update paths in Realtime DB include `bundle-metadata/*` and are consumed by `utils/bundleManager.ts`.
- Bundle endpoints are served by HTTP functions (`createTopicBundle`, `createSubtitleBundle`, etc.) in `functions/src/create*Bundle.ts`.

## Auth/Data Provider Flow Summary

- Authentication provider methods: Google, Apple, Microsoft OAuth via Firebase Auth (`context/user/UserContext.tsx`).
- Authorization model is custom-claim role based (`admin`, `publisher`, `uploader`, `user`) defined in `types/User.ts`.
- Role bootstrap for new accounts is done by `beforeUserCreated` trigger in `functions/src/setUserRoleOnCreate.ts`.
- Firestore rules in `firestore.rules` enforce role-gated write access and owner-based series/sermon controls.

## Config Surface (Observed in Code)

- Frontend/runtime flags: `NODE_ENV`, `NEXT_PUBLIC_NODE_ENV`, `PLAYWRIGHT_BASE_URL`, `TRIMMER_DEBUG_API`, `NEXT_PUBLIC_TRIMMER_DEBUG`, `NEXT_PUBLIC_TRIMMER_DEBUG_API`.
- Search config: `NEXT_PUBLIC_ALGOLIA_APP_ID`, `NEXT_PUBLIC_ALGOLIA_API_KEY`.
- Functions URL override: `NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL` (`utils/bundleManager.ts`).
- Subsplash credentials: `EMAIL`, `PASSWORD` (`functions/src/subsplashUtils.ts`, subsplash callable handlers).
- SoundCloud secret: `SOUNDCLOUD_CLIENT_SECRET` (Functions Secret Manager via `defineSecret`).
- Dolby credentials: `DOLBY_API_KEY`, `DOLBY_API_SECRET`.
- Emulator plumbing: `FUNCTIONS_EMULATOR`, `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, `GCLOUD_PROJECT`.

## Risk Notes (Current State)

- Subsplash auth uses static env email/password (`EMAIL`/`PASSWORD`) in multiple functions; rotation and blast radius risk are high compared to short-lived secrets.
- Algolia admin key is referenced as `NEXT_PUBLIC_ALGOLIA_API_KEY` in both client and server contexts (`components/*`, `functions/src/generateAlgoliaSecureApiKey.ts`), creating accidental client exposure risk.
- Dolby token helper logs key/secret and bearer token (`functions/src/Dolby/getDolbyToken.ts`, `transcodeAudio.ts`), which is a sensitive logging risk.
- Hybrid callable invocation patterns exist (`httpsCallable` name-based and `httpsCallableFromURL` direct Cloud Run URL in `utils/createFunction.ts`), increasing deployment coupling risk.
- Audio task generator hardcodes production Cloud Run URI (`functions/src/addIntroOutro/addintrooutrotaskgenerator.ts`), so environment portability depends on manual code edits.
- Firestore rules expose public reads for `/metadata/*` in `firestore.rules`; intended for bundle timestamps, but still expands anonymous read surface.
- `firebase/firebase.ts` embeds full Firebase web config inline; normal for client apps, but it reinforces need for strict backend rules.
- `.env` includes keys (for example Clerk-related names) that are not reflected in active package deps, indicating possible stale config surface and operator confusion risk.

## Secondary/Tooling Integrations

- Python helper scripts under `scrapers/` integrate with Subsplash REST APIs for tag/list synchronization and backfill operations.
- Playwright E2E integration is configured in `playwright.config.ts` and test files under `tests/`.
- Firebase emulator import/export workflows rely on local artifact directories under `dir/` and scripts in root `package.json`.
