# Architecture Map (focus: arch)

## Architectural Pattern
- The app is a **Pages Router Next.js frontend** plus a **Firebase Cloud Functions backend** in the same workspace (`package.json` workspaces: `.` and `functions`).
- UI requests are handled in `pages/*` and composed via a global app shell in `pages/_app.tsx`.
- Domain mutations and external system sync are delegated to callable/HTTP functions exposed from `functions/src/index.ts`.
- Firestore document listeners in `functions/src/DocumentListeners/**` enforce denormalized consistency and side effects after writes.
- This is effectively a layered serverless architecture: browser UI -> Firebase SDK/functions -> Firestore/Storage/RTDB -> external APIs (Subsplash, SoundCloud, Algolia).

## Runtime Layers
- **Presentation layer**: route files in `pages/*.tsx`, `pages/admin/**/*.tsx`, shared layouts in `layout/AppLayout.tsx` and `layout/SidebarLayout.tsx`, and view components under `components/**`.
- **Client state/auth layer**: `context/user/UserContext.tsx` (identity + role capabilities), `context/audio/audioPlayerContext.tsx` (global player), and `context/trimmerStore.ts` (Zustand trimmer state).
- **Client data-access layer**: Firebase client modules in `firebase/*.ts`, callable wrappers in `utils/createFunction.ts`, bundle cache access via `utils/bundleManager.ts` and `utils/bundleHelpers.ts`.
- **Domain contract layer**: shared model definitions and converters in `types/*.ts` (e.g., `types/Sermon.ts`, `types/List.ts`, `types/Series.ts`) and mirrored admin converters in `functions/src/firestoreDataConverter.ts`.
- **Backend function layer**: callable functions, HTTP bundle handlers, and task handlers under `functions/src/**`.
- **Persistence layer**: Firestore (`sermons`, `lists`, `series` + nested subcollections), Realtime Database (bundle metadata and add-intro/outro progress), and Storage buckets.

## Primary Entry Points
- Frontend app bootstrap: `pages/_app.tsx`.
- Main upload screen: `pages/index.tsx` -> `components/uploaderComponents/VerifiedUserUploaderComponent.tsx` -> `components/uploaderComponents/UploaderComponent.tsx`.
- Admin surfaces: `pages/admin/sermons.tsx`, `pages/admin/sermons/[sermonId].tsx`, `pages/admin/series.tsx`, `pages/admin/series/[seriesId].tsx`, `pages/admin/lists.tsx`, `pages/admin/users.tsx`.
- Login/auth route: `pages/login.tsx` with providers in `components/Login.tsx`.
- Cloud function export hub: `functions/src/index.ts`.
- Background audio processing pipeline: `functions/src/addIntroOutro/addintrooutrotaskgenerator.ts` and `functions/src/addIntroOutro/addintrooutrotaskhandler.ts`.

## Key Flow: Authentication + Authorization
- Client sign-in providers are executed from `components/Login.tsx` via `context/user/UserContext.tsx`.
- `UserContext` writes Firebase ID token to `nookies` cookie (`token`) for SSR-compatible checks.
- SSR guard helper in `components/ProtectedRoute.tsx` verifies cookie token with `firebase/firebaseAdmin.ts`.
- UI authorization is role-capability based (`types/User.ts`: `isAdmin`, `canUpload`, `canPublish`) and enforced in `layout/AppLayout.tsx`, page wrappers, and action buttons.
- Functions enforce server-side authorization again using custom claims (`canUserRolePublish` checks in `functions/src/*`).

## Key Flow: Upload, Trim, Process, Publish
- Upload form state is orchestrated in `components/uploaderComponents/UploaderComponent.tsx`.
- Client-side upload orchestration lives in `pages/api/uploadFile.tsx` (called directly as a module, not via HTTP).
- Initial sermon + list/series membership docs are created in Firestore before/alongside media upload.
- Processing is kicked off through callable `addintrooutrotaskgenerator` using `createFunctionV2` URL invocations (`utils/createFunction.ts`).
- Task handler `functions/src/addIntroOutro/addintrooutrotaskhandler.ts` trims/transcodes/merges intro/outro, updates sermon `status.audioStatus`, and writes progress to RTDB path `addIntroOutro/{sermonId}`.
- Processed audio lands in storage path `intro-outro-sermons/{sermonId}` and is consumed by the player (`components/MediaPlayerComponent.tsx`).
- Publishing to external platforms is handled by callable functions (`functions/src/uploadToSubsplash.ts`, `functions/src/uploadToSoundCloud.ts`).

## Key Flow: List and Series Consistency
- Denormalized links are intentionally maintained both ways:
- `lists/{listId}/listItems/{sermonId}` and `sermons/{sermonId}/sermonLists/{listId}` are synced by listeners `functions/src/DocumentListeners/Lists/listItemOnCreate.ts`, `listItemOnDelete.ts`, `listOnUpdate.ts`, and `functions/src/DocumentListeners/SermonLists/*`.
- Sermon counters (`numberOfLists`, `numberOfListsUploadedTo`) are transactionally updated in `functions/src/DocumentListeners/SermonLists/sermonListOnCreate.ts`, `sermonListOnUpdate.ts`, and `sermonListOnDelete.ts`.
- Overflow behavior for Subsplash lists is encapsulated in callable `functions/src/addToList.ts` and helper `functions/src/helpers/addToListHelpers.ts`.
- Media series domain is separate from generic lists: `series/{seriesId}` + `seriesItems` managed via `functions/src/createSeries.ts`, `addToSeries.ts`, `removeFromSeries.ts`, `reorderSeriesItems.ts`, and `deleteSeries.ts`.
- Series aggregate metadata (`itemCount`, `publishedItemCount`, `subtitle`) is recalculated in listener `functions/src/DocumentListeners/Series/seriesItemOnWrite.ts`.

## Key Flow: Bundle-Based Read Optimization
- Bundle definitions are centralized in `shared/bundleConfigs.ts`.
- HTTP bundle endpoints (`functions/src/createTopicBundle.ts`, `createSubtitleBundle.ts`, `createBibleChapterBundle.ts`, `createSundayHomilyBundle.ts`, `createLatestListBundle.ts`) serve from storage cache or regenerate via `functions/src/utils/bundleCreationUtils.ts`.
- Change triggers for bundle refresh are generated with `createBundleDocumentListener` in `functions/src/utils/bundleListenerUtils.ts` and wired in `functions/src/DocumentListeners/Topics/topicOnWrite.ts`, `Lists/subtitleListOnWrite.ts`, and `Lists/taggedListOnWrite.ts`.
- Client consumption path is `utils/bundleManager.ts` + `utils/bundleHelpers.ts`; uploader selectors fall back to live Firestore if bundle fetch fails.

## Cross-Cutting Abstractions
- **Converter pattern**: model defaults + Firestore conversion in `types/*` and admin converters in `functions/src/firestoreDataConverter.ts`.
- **Function invocation adapters**: callable by name (`createFunction`) vs direct URL Cloud Run-style (`createFunctionV2`) in `utils/createFunction.ts`.
- **Role capability API**: centralized permission helpers in `types/User.ts` used by both frontend and backend.
- **Layout extension point**: per-page static `PageLayout` in `pages/*` consumed by `pages/_app.tsx`.
- **Media player shell**: singleton player context + floating UI in `context/audio/audioPlayerContext.tsx` and `components/BottomAudioBar.tsx`.

## External Integrations
- Subsplash OAuth and API calls in `functions/src/subsplashUtils.ts` and associated helpers/callables.
- SoundCloud upload/update/delete via `functions/src/soundcloudClient.ts` and secrets in `functions/src/soundcloudSecrets.ts`.
- Algolia secure search key generation in `functions/src/generateAlgoliaSecureApiKey.ts`; frontend search in `components/SearchableAdminSermonsList.tsx` and fallback emulator mock in `utils/mockAlgoliaSearchClient.ts`.

## Deployment/Execution Boundaries
- Frontend build/runtime is Next.js (`next.config.js`, scripts in root `package.json`).
- Functions compile/deploy independently from `functions/package.json` and are configured in `firebase.json`.
- Local development couples Next dev server with Firebase emulators (`package.json` scripts `dev`, `next-dev`, `start-emulators`).
