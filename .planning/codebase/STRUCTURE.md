# Codebase Structure Map (focus: arch)

## Top-Level Layout
- `pages/`: Next.js Pages Router routes (public, admin, and local API helper modules).
- `components/`: reusable UI and feature components (uploader, trimmer, search, admin tables, player).
- `layout/`: app-level wrappers (`AppLayout`, `SidebarLayout`).
- `context/`: React context + Zustand store for auth, audio player, and trimmer state.
- `firebase/`: client/admin Firebase initialization and per-service adapters.
- `functions/`: independent Cloud Functions package (callables, HTTP handlers, listeners, tasks, tests).
- `types/`: shared domain types and Firestore converters used by frontend and backend.
- `utils/`: client-side helper utilities (function invocation, search, bundle access, media helpers).
- `shared/`: cross-workspace shared configuration (`shared/bundleConfigs.ts`).
- `tests/`: Playwright end-to-end tests.
- `scripts/`: dev tooling scripts (e.g., emulator admin account bootstrap).
- `constants/`, `reducers/`, `hooks/`, `styles/`: focused supporting modules.

## Route Organization (`pages/`)
- Root app bootstrap: `pages/_app.tsx` and document customization in `pages/_document.tsx`.
- Public/auth routes: `pages/index.tsx`, `pages/login.tsx`, `pages/profile.tsx`.
- Admin namespace uses nested routing: `pages/admin/sermons.tsx`, `pages/admin/sermons/[sermonId].tsx`, `pages/admin/sermons/[sermonId]/edit.tsx`, `pages/admin/series.tsx`, `pages/admin/series/[seriesId].tsx`, `pages/admin/lists.tsx`, `pages/admin/lists/[listId].tsx`, `pages/admin/users.tsx`, `pages/admin/topics.tsx`, `pages/admin/speakers.tsx`.
- `pages/api/*` currently contains **imported client-side service modules** (`pages/api/uploadFile.tsx`, `pages/api/editSermon.ts`, `pages/api/addNewList.ts`) plus one true API endpoint `pages/api/debug/trimmer.ts`.

## Component Organization (`components/`)
- Generic/shared widgets at root (`components/PopUp.tsx`, `components/UserTable.tsx`, `components/DeleteEntityPopup.tsx`).
- Uploader feature cluster in `components/uploaderComponents/*` (selectors, upload button, validation utilities, progress UI).
- Trimmer feature split between `components/audioTrimmerComponents/*` and low-level primitives in `components/trimmer/*`.
- Algolia-specific widgets grouped in `components/algoliaComponents/*`.
- Skeleton loading components isolated in `components/skeletons/*`.
- Player UI split into host and chrome: `components/MediaPlayerComponent.tsx` and `components/BottomAudioBar.tsx`.

## State and Data Access
- Auth/session state: `context/user/UserContext.tsx` with dev constants in `context/user/devAuth.ts`.
- Audio playback state: `context/audio/audioPlayerContext.tsx` using reducer `reducers/audioPlayerReducer.ts`.
- Trimmer interaction state: `context/trimmerStore.ts` (Zustand).
- Firebase client service modules are one-file-per-service: `firebase/auth.ts`, `firebase/firestore.ts`, `firebase/storage.ts`, `firebase/functions.ts`, `firebase/database.ts`, with shared app init in `firebase/firebase.ts` and admin SDK in `firebase/firebaseAdmin.ts`.

## Shared Domain Contracts (`types/` + `shared/`)
- Core entities: `types/Sermon.ts`, `types/SermonTypes.ts`, `types/List.ts`, `types/Series.ts`, `types/SermonList.ts`, `types/Topic.ts`, `types/Speaker.ts`, `types/User.ts`, `types/Image.ts`.
- Frontend Firestore converter pattern is colocated with each model (e.g., `sermonConverter`, `listConverter`, `seriesConverter`).
- Backend admin converters are centralized in `functions/src/firestoreDataConverter.ts`.
- Bundle generation/trigger configuration is shared via `shared/bundleConfigs.ts`.

## Backend Package Structure (`functions/src/`)
- Export surface: `functions/src/index.ts`.
- Callables grouped by domain/action at top level (e.g., `uploadToSubsplash.ts`, `uploadToSoundCloud.ts`, `addToList.ts`, `createSeries.ts`).
- Firestore listeners grouped by collection domain in `functions/src/DocumentListeners/Lists/*`, `Sermons/*`, `SermonLists/*`, `Series/*`, `Topics/*`, `Images/*`.
- Audio processing pipeline isolated in `functions/src/addIntroOutro/*` (task generator, task handler, ffmpeg helpers).
- External integration helpers in `functions/src/helpers/*`, `functions/src/subsplashUtils.ts`, `functions/src/soundcloudClient.ts`.
- Bundle infrastructure in `functions/src/utils/bundleCreationUtils.ts` and `functions/src/utils/bundleListenerUtils.ts` with HTTP handlers in `functions/src/create*Bundle.ts`.
- Function unit/integration tests in `functions/src/test/**` by domain (`addToList`, `removeFromList`, `series`, `soundcloud`).

## Testing and Tooling Layout
- Browser E2E tests: `tests/*.spec.ts` with helpers in `tests/helpers/*` and config in `playwright.config.ts`.
- Legacy/simple tests in `test/test.ts` and `test/utils.ts`.
- Dev bootstrap script: `scripts/create-dev-admin.ts` for emulator auth user setup.
- Scraping/one-off data scripts in `scrapers/**` and `extract_subsplash_ids.py`.

## Naming and File Conventions
- React components and pages use `PascalCase` filenames (`MediaPlayerComponent.tsx`, `SearchableAdminSermonsList.tsx`) except route-required filenames in `pages/`.
- Dynamic route params follow Next.js bracket syntax (`[sermonId].tsx`, `[seriesId].tsx`, `[listId].tsx`).
- Cloud Function source files are typically lower camel/lowercase action names (`addToList.ts`, `removeFromSeries.ts`), then exported in lowercase aliases in `functions/src/index.ts` (e.g., `exports.addtolist`).
- Feature-specific folders are used when behavior is complex (`components/uploaderComponents`, `functions/src/addIntroOutro`, `functions/src/DocumentListeners`).
- Relative imports dominate across the repo; there is no broad path-alias convention in current source.
- Status/role logic is centralized into enums/constants (`types/SermonTypes.ts`, `types/User.ts`, `types/List.ts`) rather than hardcoded per component.

## Operational Files
- Firebase project/runtime config in `firebase.json`, `firestore.rules`, `firestore.indexes.json`, `database.rules.json`, `storage.rules`.
- Next runtime config in `next.config.js`.
- Monorepo dependency/workspace config in root `package.json` and `pnpm-workspace.yaml`.
