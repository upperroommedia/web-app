# Technology Stack

**Analysis Date:** 2026-02-24

## Languages

**Primary:**
- TypeScript - Main application and Cloud Functions code in `pages/`, `components/`, `utils/`, `context/`, and `functions/src/`

**Secondary:**
- JavaScript - Config and tooling files such as `next.config.js`, `jest.config.js`, `.eslintrc.json`
- CSS - Styling in `styles/`

## Runtime

**Environment:**
- Node.js 22 (declared in root `package.json` and `functions/package.json`)
- Browser runtime for Next.js pages and React client components
- Firebase Emulator Suite in local development (Auth, Firestore, Functions, Storage, RTDB)

**Package Manager:**
- pnpm 10.10.0 (`packageManager` in root `package.json`)
- Lockfile: `pnpm-lock.yaml` present
- Workspace layout: root app + `functions` workspace

## Frameworks

**Core:**
- Next.js 15.3.8 (`pages` router)
- React 19.1.0 + React DOM 19.1.0
- Firebase client SDK v9 (`firebase`) for auth, Firestore, Storage, RTDB, callable functions
- Firebase Functions v2 (`firebase-functions`) for backend APIs and document triggers

**UI/UX:**
- Material UI v7 (`@mui/material`, icons, system)
- `@vidstack/react` for media player controls
- `@dnd-kit/*` for drag/interaction features

**Testing:**
- Jest + `ts-jest` for functions/unit style tests
- Playwright for browser E2E tests in `tests/`

**Build/Dev:**
- TypeScript 4.9.5 (`tsconfig.json` + functions `tsconfig`)
- Next.js Turbopack for dev (`next dev --turbopack`)
- Firebase CLI/emulators via `firebase-tools`

## Key Dependencies

**Critical app/platform dependencies:**
- `next`, `react`, `react-dom` - web app runtime
- `firebase`, `firebase-admin`, `firebase-functions` - app/backend data + serverless
- `@mui/material` - core admin UI component system
- `algoliasearch`, `instantsearch.js`, `react-instantsearch` - admin/search experiences
- `@vidstack/react` - audio player/trimmer media stack
- `zustand` - trimmer state management

**Critical backend/media dependencies (`functions`):**
- `axios` + `form-data` - external API calls (Subsplash, SoundCloud, Dolby)
- `@google-cloud/storage` - signed URLs, bucket I/O
- `ffmpeg-static`, `ffprobe-static`, `fluent-ffmpeg`, `sharp`, `imagemagick` - media/image processing
- `node-fetch`/`ytdl-core` - download/processing workflows for YouTube audio paths

## Configuration

**Environment/config files:**
- Root: `.env`, `.nvmrc`, `next.config.js`, `tsconfig.json`, `.eslintrc.json`, `.prettierrc.json`
- Firebase: `firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `database.rules.json`
- Functions: `functions/package.json`, functions TypeScript build outputs under `functions/lib/`

**Known env vars used in code:**
- Client/web: `NEXT_PUBLIC_ALGOLIA_APP_ID`, `NEXT_PUBLIC_ALGOLIA_API_KEY`, `NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL`, `NEXT_PUBLIC_TRIMMER_DEBUG`, `NEXT_PUBLIC_TRIMMER_DEBUG_API`
- Server/functions: `EMAIL`, `PASSWORD`, `DOLBY_API_KEY`, `DOLBY_API_SECRET`, `SOUNDCLOUD_ACCESS_TOKEN` (secret manager), emulator vars (`FIRESTORE_EMULATOR_HOST`, etc.)

## Platform Requirements

**Development:**
- Node 22 + pnpm
- Firebase Emulator Suite for local app/backend testing
- Local Firestore export/import data under `dir/`

**Production:**
- Next.js hosting target appears Vercel-oriented (`vercel.json`, `.vercel/`)
- Backend deployed as Firebase Functions v2 / Cloud Run-style callable endpoints
- Firebase project `urm-app` for Auth/Firestore/Storage/RTDB

---

*Stack analysis: 2026-02-24*
*Update after major dependency/runtime changes*
