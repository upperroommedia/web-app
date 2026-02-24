# Architecture

**Analysis Date:** 2026-02-24

## Pattern Overview

**Overall:** Full-stack TypeScript monorepo with a Next.js admin/web frontend plus Firebase Functions v2 backend.

**Key Characteristics:**
- UI-first admin tool in `pages/` + `components/`
- Firebase-centric data and identity model (Auth, Firestore, Storage, RTDB)
- Serverless integration layer for external publishing/media systems (Subsplash, SoundCloud, Dolby)
- Mixed real-time and batch style flows (Firestore listeners + callable functions + bundle generation)

## Layers

**Presentation Layer (Next.js pages + React components):**
- Purpose: Render uploader/admin experiences and collect user actions
- Contains: route pages (`pages/admin/*`, `pages/index.tsx`, `pages/login.tsx`) and feature components (`components/*`)
- Depends on: contexts, utilities, Firebase client wrappers
- Used by: browser clients

**Client State & Access Layer:**
- Purpose: Centralize auth/player/trimmer state and data access helpers
- Contains: `context/user/UserContext.tsx`, `context/audio/audioPlayerContext.tsx`, `context/trimmerStore.ts`, `utils/createFunction.ts`
- Depends on: Firebase SDK wrappers in `firebase/*`
- Used by: page and component layer

**Application Service Layer (Cloud Functions):**
- Purpose: privileged operations and external system orchestration
- Contains: callable functions in `functions/src/*` (upload, edit, list/series management, media tasks)
- Depends on: Firebase Admin SDK, external APIs, helper modules
- Used by: client callable invocations and event triggers

**Data/Event Layer:**
- Purpose: persistence and derived-data maintenance
- Contains: Firestore collections/subcollections, RTDB metadata docs, Storage objects, document listeners in `functions/src/DocumentListeners/*`
- Depends on: Firebase platform
- Used by: both frontend and functions

## Data Flow

**Upload + processing flow:**
1. User uploads file/YouTube URL from `pages/index.tsx` uploader stack
2. Client writes sermon/list/series references to Firestore via `pages/api/uploadFile.tsx`
3. Client triggers callable `addintrooutrotaskgenerator`
4. Functions process media (`functions/src/addIntroOutro/*`) and store output in Firebase Storage
5. UI and player consume generated assets

**Publish flow (Subsplash/SoundCloud):**
1. Admin page actions (`pages/admin/sermons/[sermonId].tsx`, `components/ManagePublishingPopup.tsx`)
2. Client calls backend via `createFunctionV2`
3. Function validates role claims and performs API calls
4. Function updates Firestore records and returns integration IDs/status

**Bundle generation flow:**
1. Firestore writes trigger listeners (`functions/src/DocumentListeners/*`)
2. Bundle utilities regenerate typed Firestore bundles
3. Bundles are stored in GCS and metadata updated in RTDB
4. Clients load/cached bundle content via `utils/bundleManager.ts`

**State Management:**
- Auth/session: React context + Firebase auth state
- Audio player: reducer/context (`reducers/audioPlayerReducer.ts`)
- Trimmer: Zustand store (`context/trimmerStore.ts`)
- Data subscription: Firestore hooks and explicit function/API calls

## Key Abstractions

**Role & permission helpers:**
- Purpose: consistent authorization semantics
- Examples: `types/User.ts` (`canUserRoleUpload`, `canUserRolePublish`, `isUserRoleAdmin`)
- Pattern: shared pure functions used in frontend and backend

**Callable function factory:**
- Purpose: normalize local emulator vs deployed callable endpoints
- Examples: `utils/createFunction.ts`
- Pattern: small transport abstraction returning typed async functions

**Bundle configuration + generic builders:**
- Purpose: avoid duplicated logic for topics/subtitles/bible/sunday/latest bundles
- Examples: `shared/bundleConfigs.ts`, `functions/src/utils/bundleCreationUtils.ts`
- Pattern: config-driven generic utilities

## Entry Points

**Web app bootstrap:**
- Location: `pages/_app.tsx`
- Triggers: all page navigations
- Responsibilities: global providers, theming, media player wiring, page layout handoff

**Web routes:**
- Location: `pages/*`
- Triggers: browser HTTP requests and client navigation
- Responsibilities: render uploader/admin/detail workflows

**Functions export hub:**
- Location: `functions/src/index.ts`
- Triggers: Firebase callable/HTTP/document event wiring
- Responsibilities: export and register all function handlers

## Error Handling

**Strategy:**
- Backend callables throw `HttpsError` for auth/validation failures
- Integration failures handled via helper wrappers (e.g., `handleError`) and logged with `firebase-functions` logger
- Client paths use a mix of `try/catch`, alert/console logging, and optimistic UI updates

**Patterns:**
- Role checks near function entry points
- Batch/transaction use for Firestore consistency in list/series mutation paths
- Best-effort cleanup after upload failures in `pages/api/uploadFile.tsx`

## Cross-Cutting Concerns

**Authentication/authorization:**
- Firebase auth tokens + custom role claims in both UI guards and backend function guards

**Logging/debugging:**
- Functions logger for backend
- Client trimmer debug instrumentation (opt-in env toggles)

**Media handling:**
- Shared intro/outro and trimming paths across UI and functions
- Storage object lifecycle managed in upload and cleanup code paths

---

*Architecture analysis: 2026-02-24*
*Update when major data flow or layer boundaries change*
