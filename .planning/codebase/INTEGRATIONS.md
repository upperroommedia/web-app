# External Integrations

**Analysis Date:** 2026-02-24

## APIs & External Services

**Content publishing APIs:**
- Subsplash (`core.subsplash.com`) - publish/edit/delete media items, lists, and series
  - Key implementation: `functions/src/subsplashUtils.ts`, `functions/src/uploadToSubsplash.ts`, `functions/src/helpers/seriesHelpers.ts`
  - Auth: OAuth password grant via `EMAIL`/`PASSWORD` env vars
  - Main domains: `/accounts/v1/oauth/token`, `/media/v1/*`, `/builder/v1/*`, `/transcoder/v1/jobs`

**Audio distribution:**
- SoundCloud API (`api.soundcloud.com`) - upload/update/delete tracks
  - Key implementation: `functions/src/soundcloudClient.ts`, `functions/src/uploadToSoundCloud.ts`, `functions/src/editSoundCloudSermon.ts`
  - Auth: OAuth token from Firebase Secret Manager (`SOUNDCLOUD_ACCESS_TOKEN`)

**Media processing external API:**
- Dolby API (`api.dolby.io`) - token and transcode support paths
  - Key implementation: `functions/src/Dolby/getDolbyToken.ts`, `functions/src/Dolby/transcodeAudio.ts`
  - Auth: `DOLBY_API_KEY` + `DOLBY_API_SECRET`

**Search service:**
- Algolia - admin search/filter UX
  - Key implementation: `components/SearchableAdminSermonsList.tsx`, `utils/mockAlgoliaSearchClient.ts`
  - Auth: `NEXT_PUBLIC_ALGOLIA_APP_ID`, `NEXT_PUBLIC_ALGOLIA_API_KEY` (client), plus secure key flow via function `generatesecuredapikey`

**Media source input:**
- YouTube URLs for trimming/upload generation
  - Key implementation: `components/YouTubeTrimmer.tsx`, `functions/src/addIntroOutro/*`, `functions/src/addIntroOutro/trimAndTranscode.ts`

## Data Storage

**Primary database:**
- Cloud Firestore (Firebase)
  - Client access wrappers: `firebase/firestore.ts`
  - Admin access: `firebase/firebaseAdmin.ts`
  - Heavy usage across `pages/admin/*`, `pages/api/*`, and `functions/src/*`

**Secondary database:**
- Firebase Realtime Database
  - Used for bundle metadata and listener coordination (`shared/bundleConfigs.ts`, `functions/src/utils/bundleListenerUtils.ts`)

**File/object storage:**
- Firebase Storage / GCS bucket `urm-app.appspot.com`
  - Sermon files, intro/outro assets, images, generated bundles
  - Client wrapper: `firebase/storage.ts`
  - Backend signed URL + bucket operations in `functions/src/getOutputUrl.ts` and media functions

**Caching/bundle layer:**
- Firebase Firestore Bundles served from Cloud Storage, with metadata tracked in RTDB
  - Core docs + code: `docs/BUNDLE_SYSTEM.md`, `functions/src/utils/bundleCreationUtils.ts`, `shared/bundleConfigs.ts`

## Authentication & Identity

**Auth provider:**
- Firebase Authentication
  - Client auth flows (email/password + OAuth providers): `context/user/UserContext.tsx`
  - Providers observed: Google, Apple, Microsoft

**Authorization model:**
- Role-based access via custom claims (`admin`, `publisher`, `uploader`, `user`)
  - Role helpers in `types/User.ts`
  - Used in callable functions and UI guards

**Server-side route protection:**
- Cookie token verification with Admin SDK in `components/ProtectedRoute.tsx` and `utils/protectedRoutes.ts`

## Monitoring & Observability

**Backend logging:**
- `firebase-functions` logger in Cloud Functions
- Local/emulator logs and debug files: `firestore-debug.log`, `firebase-debug.log`, `database-debug.log`

**Client debug instrumentation:**
- Trimmer debug client logger posting to `pages/api/debug/trimmer.ts` when enabled by env flags

**Error tracking/analytics:**
- No dedicated Sentry-style service discovered in repo
- Google Analytics capability present via Firebase analytics initialization in `firebase/firebase.ts`

## CI/CD & Deployment

**Hosting/deployment:**
- Web: Next.js app with Vercel-oriented config (`vercel.json`)
- Backend: Firebase Functions deployment (`functions/package.json` script `deploy`)

**Build/deploy configs:**
- Firebase config and predeploy hooks in `firebase.json`
- Functions compile from TypeScript before deploy (`npm --prefix "$RESOURCE_DIR" run build`)

**CI workflows:**
- No active GitHub Actions workflow files found under `.github/workflows/` in this repo snapshot

## Environment Configuration

**Development:**
- `pnpm dev` starts Next.js + emulator stack (`start-emulators`)
- Local callable URL routing in `utils/createFunction.ts` to emulator endpoints

**Staging/Production differences:**
- `createFunctionV2` switches callable endpoint between emulator and Cloud Run-style URL
- Auth/storage/firestore wrappers switch emulator connections in dev only

**Critical env vars and secrets:**
- External API credentials (Subsplash email/password, Dolby keys, SoundCloud token)
- Search keys and trimmer debug toggles

## Webhooks & Callbacks

**Incoming webhooks:**
- No third-party webhook endpoint pattern identified

**Event-driven callbacks:**
- Firestore document listeners in `functions/src/DocumentListeners/*` trigger bundle updates, list/sermon maintenance, and metadata sync

**Outgoing callbacks/API pushes:**
- Subsplash/SoundCloud update operations from callable functions and admin flows

---

*Integration audit: 2026-02-24*
*Update when adding/removing external services or secrets strategy*
