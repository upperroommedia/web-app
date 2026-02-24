# Coding Conventions

**Analysis Date:** 2026-02-24

## Naming Patterns

**Files:**
- `PascalCase.tsx` for React UI components (e.g., `ManagePublishingPopup.tsx`)
- `camelCase.ts` for helpers/utilities and backend modules (e.g., `createFunction.ts`, `uploadToSubsplash.ts`)
- Tests:
  - Functions: `*.test.ts` under `functions/src/test/`
  - E2E: `*.spec.ts` under `tests/`

**Functions:**
- `camelCase` for most function names/locals
- Backend callables often named as action verbs (`addToList`, `uploadToSoundCloud`, `removeFromList`)
- Event handlers typically reflect trigger source (`topicOnWrite`, `sermonListOnCreate`)

**Variables:**
- `camelCase` for local vars and state
- Constants usually `UPPER_SNAKE_CASE` (e.g., `DRAWER_WIDTH`, `DEFAULT_EMULATOR_HOST`)

**Types:**
- `PascalCase` interfaces/types (e.g., `UploadToSoundCloudInputType`, `AudioPlayerState`)
- Role and enum-like constants in `types/` with helper predicates

## Code Style

**Formatting:**
- Prettier config in `.prettierrc.json`
- 120 print width, 2 spaces, semicolons enabled, single quotes

**Linting:**
- Root ESLint extends: `standard`, `plugin:react/recommended`, `plugin:@next/next/recommended`, `plugin:react-hooks/recommended`
- `@typescript-eslint/no-unused-vars` enforced with `_` ignore patterns
- Console usage allowed with warnings (warn/error explicitly allowed)

## Import Organization

**Observed order (common pattern):**
1. External packages
2. Project-local imports (`../`, `../../`, absolute alias `@/*` when used)
3. Type imports intermixed (not strictly separated everywhere)

**Path aliases:**
- TS path alias `@/*` exists in `tsconfig.json`, though many files still use relative imports

## Error Handling

**Backend patterns:**
- Callable functions validate auth/role early and throw `HttpsError` for permission issues
- Integration errors wrapped/mapped (e.g., `handleError`) and logged with context

**Frontend patterns:**
- Async actions typically wrapped in `try/catch`
- Some legacy flows still use `alert`/`console.error` directly for surfaced failures
- Guard clauses used for auth/undefined state conditions

## Logging

**Framework:**
- Backend: `firebase-functions` logger
- Frontend: `console.*` and targeted debug utility (`utils/trimmerDebug.ts`)

**Patterns:**
- Integration functions log request phase/status details
- Debug logging can be gated via env flags (`TRIMMER_DEBUG_API`, `NEXT_PUBLIC_TRIMMER_DEBUG`)

## Comments

**When comments are used:**
- Clarifying intent for layout/perf behavior
- TODO markers for incomplete features or deferred cleanup
- Inline notes for emulator/dev-only behavior

**TODO usage:**
- TODOs exist across uploader, trimmer, and function legacy paths
- Not all TODOs are linked to issue IDs in code

## Function Design

**Common style:**
- Mix of large orchestrator functions (notably in admin pages and add-to-list flows) and focused helpers
- Guard clauses and early returns are common
- Async/await style used consistently over promise chains in most files

## Module Design

**Exports:**
- React components often default export
- Functions modules commonly default-export handler and are re-exported in `functions/src/index.ts`
- Shared types/helpers use named exports

**Composition patterns:**
- State management split by domain (User/Auth context, Audio context, Trimmer store)
- Reusable typed config-driven systems (bundle configs + generic bundle utilities)

---

*Convention analysis: 2026-02-24*
*Update when lint/format rules or naming patterns materially change*
