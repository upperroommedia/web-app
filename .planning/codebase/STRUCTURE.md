# Codebase Structure

**Analysis Date:** 2026-02-24

## Directory Layout

```text
web-app/
├── pages/                    # Next.js pages routes (admin + api + public pages)
├── components/               # Reusable UI and feature components
├── context/                  # React contexts and Zustand trimmer store
├── layout/                   # Shared page layout wrappers
├── utils/                    # Client/shared utility functions
├── types/                    # Shared domain types and converters
├── firebase/                 # Firebase client/admin wrappers
├── functions/                # Firebase Functions TypeScript workspace
│   └── src/                  # Callable functions, listeners, integrations, tests
├── shared/                   # Cross-workspace shared config (bundle configs)
├── tests/                    # Playwright E2E tests
├── test/                     # Additional test helpers/scripts
├── docs/                     # Architecture/perf/product docs
├── scripts/                  # Local tooling scripts (e.g. create dev admin)
├── public/                   # Static assets
├── styles/                   # Global and theme styling
└── .planning/codebase/       # Generated GSD codebase maps
```

## Directory Purposes

**`pages/`:**
- Purpose: route entry points and page-level orchestration
- Contains: `pages/admin/*`, `pages/api/*`, auth/upload/profile pages
- Key files: `pages/_app.tsx`, `pages/index.tsx`, `pages/admin/sermons.tsx`, `pages/api/uploadFile.tsx`

**`components/`:**
- Purpose: feature UI blocks and controls
- Contains: uploaders, sermon cards, publishing dialogs, trimmer/player components
- Key subdirs: `components/uploaderComponents`, `components/trimmer`, `components/algoliaComponents`

**`functions/src/`:**
- Purpose: backend callable + event handlers
- Contains: integrations (`uploadToSubsplash`, `uploadToSoundCloud`), listeners, helper modules, tests
- Key subdirs: `DocumentListeners/`, `addIntroOutro/`, `Scrapers/`, `utils/`, `test/`

**`firebase/`:**
- Purpose: runtime wrappers for auth/firestore/database/functions/storage
- Contains: emulator connection logic and SDK exports
- Key files: `firebase/firebase.ts`, `firebase/firestore.ts`, `firebase/functions.ts`, `firebase/firebaseAdmin.ts`

**`shared/`:**
- Purpose: shared typed bundle configuration for frontend + functions
- Key file: `shared/bundleConfigs.ts`

## Key File Locations

**Entry Points:**
- `pages/_app.tsx` - global provider wiring and layout handling
- `pages/index.tsx` - upload flow entry
- `functions/src/index.ts` - Firebase functions export registry

**Configuration:**
- `package.json` - root scripts/workspace/dependencies
- `functions/package.json` - backend workspace scripts/deps
- `next.config.js` - Next runtime/image/i18n config
- `firebase.json` - firebase project config + emulator/deploy settings
- `tsconfig.json` - root TS config

**Core Logic:**
- `components/ManagePublishingPopup.tsx` - central publish/unpublish orchestration UI
- `pages/admin/sermons/[sermonId].tsx` - sermon detail workflow
- `functions/src/addToList.ts` - list item overflow/consistency logic
- `functions/src/helpers/seriesHelpers.ts` - series API integration operations
- `utils/bundleManager.ts` - bundle lifecycle/caching behavior

**Testing:**
- `functions/src/test/*` - Jest tests for functions logic and emulator scenarios
- `tests/*.spec.ts` - Playwright E2E tests for upload/player/trimmer behavior
- `tests/helpers/seedPlayableSermon.ts` - deterministic test data seeding

**Documentation:**
- `docs/BUNDLE_SYSTEM.md` - bundle architecture doc
- `docs/PERFORMANCE_SWEEP_2026-02-23.md` - current performance audit and priorities

## Naming Conventions

**Files:**
- React component files use `PascalCase.tsx` (e.g., `SermonListCard.tsx`)
- Utility/helper files mostly use `camelCase.ts` (e.g., `createFunction.ts`, `bundleManager.ts`)
- Test files use `*.test.ts` (functions) and `*.spec.ts` (Playwright)

**Directories:**
- Feature-oriented groupings (e.g., `components/trimmer`, `functions/src/DocumentListeners`)
- Mixed casing exists in legacy folders (`Scrapers`, `Dolby`, `addIntroOutro`)

**Special Patterns:**
- `pages/admin/...` for protected admin routes
- `pages/api/...` for server-side page-adjacent handlers
- Functions exported centrally via `functions/src/index.ts`

## Where to Add New Code

**New admin feature:**
- Page route: `pages/admin/...`
- UI components: `components/...`
- Shared state/context: `context/...` (if needed)
- Backend callable: `functions/src/...` + export in `functions/src/index.ts`
- Tests: `functions/src/test/...` and/or `tests/...`

**New external integration:**
- Transport client/helper: `functions/src/...` (or `functions/src/helpers/...`)
- Callable façade: dedicated function file + index export
- Frontend invocation: `utils/createFunction.ts` callers

**New bundle type:**
- Config in `shared/bundleConfigs.ts`
- HTTP creator in `functions/src/create*Bundle.ts`
- Listener in `functions/src/DocumentListeners/...`
- Client loader in `utils/bundleHelpers.ts`/`utils/bundleManager.ts`

## Special Directories

**`.next/`:**
- Purpose: Next.js build artifacts
- Source: generated by Next build/dev
- Committed: no

**`functions/lib/` and `functions/dist/`:**
- Purpose: built function output artifacts
- Source: TypeScript build in functions workspace
- Committed: typically no (build output)

**`dir/`:**
- Purpose: local emulator import/export dataset
- Source: Firebase emulator import/export
- Committed: present in repo snapshot and used for local state seeding

---

*Structure analysis: 2026-02-24*
*Update when directory layout or ownership boundaries change*
