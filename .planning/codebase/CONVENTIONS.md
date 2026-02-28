# Coding Conventions (Quality Focus)

**Analysis date:** 2026-02-28

## Repository-wide style and tooling

- TypeScript strict mode is enabled in both app and functions (`tsconfig.json`, `functions/tsconfig.json`).
- Formatting is driven by Prettier with 120-column width, semicolons, and single quotes (`.prettierrc.json`).
- Frontend linting uses Next + React + Standard + TS plugins (`.eslintrc.json`); backend linting uses flat ESLint config (`functions/eslint.config.js`).
- Unused variables are enforced via `@typescript-eslint/no-unused-vars` with `_` ignore prefix in both roots (`.eslintrc.json`, `functions/eslint.config.js`).

## Naming and file patterns

- React components/pages follow PascalCase file names in `components/` and route-based names in `pages/` (examples: `components/EditSermonForm.tsx`, `pages/admin/sermons.tsx`).
- Utility and backend modules are mostly camelCase files (examples: `utils/createFunction.ts`, `functions/src/removeFromList.ts`).
- Cloud Function exports in `functions/src/index.ts` are lower-case keys even when the source file is camelCase (example: `exports.createseries = createseries;`).
- Domain types live in `types/` and are shared by frontend + backend imports (examples: `types/User.ts`, `types/List.ts`, `types/SermonTypes.ts`).

## Runtime boundaries and composition

- Frontend calls callable functions through typed wrappers in `utils/createFunction.ts` (`createFunction`, `createFunctionV2`).
- Root app composition is centralized in `pages/_app.tsx`: `UserProvider` -> `NextThemesProvider` -> MUI theme -> `AudioPlayerProvider`.
- Heavy UI pieces are lazily loaded with `next/dynamic` where needed (examples: `pages/_app.tsx`, `components/uploaderComponents/UploaderComponent.tsx`).
- Firestore converters are consistently attached via `.withConverter(...)` for typed collections/documents (examples: `components/EditSermonForm.tsx`, `functions/src/addToList.ts`).

## Typing and data-shape conventions

- The codebase prefers explicit domain interfaces/enums over ad-hoc maps (examples: `types/SermonTypes.ts`, `types/List.ts`).
- Empty/default object factories are used to stabilize optional Firestore payloads (examples: `types/Sermon.ts:createEmptySermon`, `types/List.ts:emptyList`).
- Converters merge defaults with snapshot data to tolerate partial/legacy documents (examples: `types/Sermon.ts`, `functions/src/firestoreDataConverter.ts`).
- Discriminated unions are used for mixed media list items (`types/ListItem.ts` with `type: 'sermon' | 'list'`).
- Firestore undefined-field handling is explicit in some converters (example: `types/Sermon.ts` filters `undefined` before write).

## Error handling and guard patterns

- Backend callable functions gate auth/role early using helpers from `types/User.ts` (`canUserRolePublish`, `canUserRoleUpload`, `isUserRoleAdmin`).
- `HttpsError` is the standard boundary error for Cloud Functions (`functions/src/createSeries.ts`, `functions/src/removeFromList.ts`, `functions/src/uploadToSoundCloud.ts`).
- Shared error normalization is centralized in `functions/src/handleError.ts` (passes through `HttpsError`, maps Axios and generic errors to `internal`).
- Document listeners typically wrap function bodies and rethrow normalized errors (`functions/src/DocumentListeners/**`).
- Frontend still has mixed error surfaces (`console.error`, `console.warn`, and dialog state), e.g. `components/uploaderComponents/UploaderComponent.tsx` and `components/Login.tsx`.

## State-management conventions

- Reducer-based global state is used for audio player control (`context/audio/audioPlayerContext.tsx`, `reducers/audioPlayerReducer.ts`).
- Zustand is used for high-frequency trimmer state and selector logic (`context/trimmerStore.ts`).
- Hooks memoize callbacks/selectors in performance-sensitive contexts (`context/audio/audioPlayerContext.tsx`, trimmer hooks under `components/trimmer/`).

## Operational conventions that affect quality

- Local dev is expected to run with Firebase emulators via `pnpm dev` (`package.json`) and emulator wiring in `firebase/*.ts`.
- Dev auth flow depends on a seeded emulator admin user (`scripts/create-dev-admin.ts`) and a dev-only login button (`components/Login.tsx`).
- Bundle-backed list/topic/subtitle loading relies on cache + timestamp checks (`utils/bundleManager.ts`, `utils/bundleHelpers.ts`, `shared/bundleConfigs.ts`).
- Functions tests intentionally use separate emulator ports from app-dev (`firebase.test.json` vs `firebase.json`).

## Quality-specific inconsistencies to watch

- Some APIs still use loose `any` defaults (`utils/createFunction.ts`) and broad `Record<string, unknown>` writes (`functions/src/createSeries.ts`).
- Naming consistency is imperfect in functions exports (mix of camelCase source and lowercase export aliases in `functions/src/index.ts`).
- Legacy code remains in active tree (`functions/src/old_addToList.ts`, `functions/src/handleImageUploadOld.ts`).
- TODO markers highlight unfinished behavior in production paths (`components/uploaderComponents/UploaderComponent.tsx`, `functions/src/DocumentListeners/Lists/listItemOnCreate.ts`, `pages/api/uploadFile.tsx`).
- `ListItemConverter` and admin converter mutate `listItem.mediaItem` during conversion (`types/ListItem.ts`, `functions/src/firestoreDataConverter.ts`), which can surprise callers reusing object references.
