# Stack Mapping (Tech Focus)

## Repository Shape
- This is a PNPM workspace rooted at `package.json` with workspace entries in `pnpm-workspace.yaml`.
- Active workspace packages are root app (`.`) and Cloud Functions package (`functions`) from `pnpm-workspace.yaml`.
- A separate Cloud Run app exists in `youtube-to-mp3-cloud-run/` with its own `package.json` and `Dockerfile`.

## Languages and Source Types
- Primary language is TypeScript across Next.js UI and Firebase Functions (`tsconfig.json`, `functions/tsconfig.json`).
- JavaScript is still present in configs and legacy/service files (`next.config.js`, `youtube-to-mp3-cloud-run/index.js`).
- Python is used for one-off data/scraping tooling in `scrapers/*.py`, `scrapers/helpers/*.py`, and `extract_subsplash_ids.py`.
- CSS Modules and global CSS are used for styling (`styles/*.module.css`, `styles/globals.css`).

## Frontend Runtime and Frameworks
- Web app uses Next.js Pages Router (`pages/`), pinned to `next@15.3.8` in root `package.json`.
- React runtime is `react@19.1.0` + `react-dom@19.1.0` from root `package.json`.
- MUI is the component system (`@mui/material`, `@mui/icons-material`, `@mui/x-date-pickers` in `package.json`).
- Theme switching is handled with `next-themes` and MUI themes in `pages/_app.tsx` and `styles/theme.ts`.
- Turbopack is used for local dev via script `next dev --turbopack` in `package.json`.

## Backend Runtime and Frameworks
- Firebase Cloud Functions live in `functions/src/` and export from `functions/src/index.ts`.
- Functions package uses `firebase-functions@^6.3.2` and `firebase-admin@^13.4.0` (`functions/package.json`).
- Newer functions are mostly v2 APIs (`firebase-functions/v2/https`, `/firestore`, `/storage`, `/tasks`).
- A few handlers still use v1-style wrapper imports (`https.onCall` patterns in files like `functions/src/setUserRole.ts`).
- Root + functions engines both require Node `22` (`package.json`, `functions/package.json`), with `.nvmrc` also set to `22`.

## Package Management and Toolchain
- Package manager is PNPM `10.10.0` (locked in root `package.json` `packageManager`).
- Repo uses hoisted node linker config in `.npmrc` (`node-linker=hoisted`, `shamefully-hoist=true`).
- TypeScript is pinned to `4.9.5` in both root and functions package manifests.
- ESLint is configured in root via `.eslintrc.json`, and flat config in functions via `functions/eslint.config.js`.
- Prettier is configured by `.prettierrc.json` and formatting scripts in root `package.json`.

## Firebase Platform Footprint
- Firebase project is hardwired as `urm-app` in `firebase/firebase.ts` and config files.
- Firestore, Realtime Database, Storage, Auth, and Functions emulators are defined in `firebase.json`.
- Emulator ports in `firebase.json`: Firestore `8081`, Auth `9099`, Functions `5001`, DB `9000`, Storage `9199`, Tasks `8123`.
- Test emulator overrides live in `firebase.test.json` (Firestore `18081`, Auth `9100`).
- Security rules are versioned in `firestore.rules`, `storage.rules`, and `database.rules.json`.

## Deployment and Hosting
- Vercel deployment metadata is in `vercel.json` with build command `pnpm build-functions && pnpm build`.
- Next.js image optimization allow-list is set in `next.config.js` (`graph.facebook.com`, `lh3.googleusercontent.com`, `core.subsplash.com`, Google storage hosts, localhost entries).
- Firebase deploy configuration is in `firebase.json` with functions predeploy lint/build hooks.
- Cloud Run sidecar service for YouTube->MP3 is containerized in `youtube-to-mp3-cloud-run/Dockerfile`.

## Data and State Architecture
- Firestore is the main app datastore (`firebase/firestore.ts`, heavy usage across `pages/`, `components/`, `functions/src/`).
- Realtime Database is used for bundle metadata and task progress signals (`utils/bundleManager.ts`, `functions/src/addIntroOutro/addintrooutrotaskhandler.ts`).
- Cloud Storage buckets used include `urm-app.appspot.com` and `urm-app-images` (`firebase/firebase.ts`, `firebase/storage.ts`, `functions/src/handleImageUpload.ts`).
- Firestore bundle system is implemented across `shared/bundleConfigs.ts`, `functions/src/utils/bundleCreationUtils.ts`, and `utils/bundleManager.ts`.

## Search and Media Libraries in Stack
- Algolia JS client v5 is used client-side and server-side (`algoliasearch` in root and functions manifests).
- InstantSearch UI uses `react-instantsearch` and `instantsearch.js` (`components/SearchableAdminSermonsList.tsx`).
- Video/audio stack includes `@vidstack/react`, `fluent-ffmpeg`, `ffmpeg-static`, `ffprobe-static`, and `ytdl-core`.
- Image processing uses `sharp`, `image-size`, `buffer-image-size`, and `node-vibrant`.

## Testing and Quality Gates
- Unit/integration tests for functions run with Jest + ts-jest and Firestore emulator (`functions/jest.config.js`, `functions/src/test/*`).
- Root also has a base Jest config (`jest.config.js`) though most active tests are under `functions/src/test` and Playwright specs.
- E2E browser tests use Playwright config in `playwright.config.ts` and tests in `tests/*.spec.ts`.

## Local Development Entry Points
- Main local entry is `pnpm dev` from root `package.json`, which starts Next + emulator stack.
- Functions build watcher runs via `pnpm run build-functions-watch` chained into emulator startup.
- Dev-auth bootstrap script is `scripts/create-dev-admin.ts` (uses Auth emulator at `127.0.0.1:9099`).
- Function URL selection logic for local/prod callable routing is centralized in `utils/createFunction.ts`.

## Platform Requirements and Constraints
- Node 22 is a hard requirement for both root and functions runtime (`package.json`, `functions/package.json`, `.nvmrc`).
- Firebase emulator suite is required for full local workflows (`firebase.json`, scripts in `package.json`).
- Some media workflows require FFmpeg binaries available through dependencies (`ffmpeg-static`) or container package installs (`youtube-to-mp3-cloud-run/Dockerfile`).
- Production assumes availability of Firebase, Google Cloud Functions/Run endpoints, Algolia credentials, and external media providers referenced in code.
