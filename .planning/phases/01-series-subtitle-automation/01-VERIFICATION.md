---
phase: 01-series-subtitle-automation
status: gaps_found
verified_on: 2026-02-28
phase_goal: "Enforce canonical series subtitle/count semantics and complete independent/combined series publishing UX."
phase_requirement_ids:
  - SERIES-01
  - SERIES-02
  - SERIES-03
  - SERIES-04
---

# Phase 01 Verification

## Verdict

Implementation evidence indicates the phase goal behavior is achieved in code and tests, but traceability is incomplete because requirement IDs declared in plan frontmatter are not canonical requirement IDs from `.planning/REQUIREMENTS.md`.

## Requirement ID Cross-Reference (MANDATORY)

### Plan frontmatter requirement IDs found

- `01-01-PLAN.md`: `adhoc-series-subtitle-derived-from-published-count`
- `01-02-PLAN.md`: `adhoc-series-publish-independent-from-lists`, `adhoc-publish-everywhere-shortcut`

### REQUIREMENTS.md canonical IDs

- Series milestone IDs: `SERIES-01`, `SERIES-02`, `SERIES-03`, `SERIES-04`

### Accounting result

- `adhoc-series-subtitle-derived-from-published-count` -> **NOT FOUND** in `.planning/REQUIREMENTS.md`
- `adhoc-series-publish-independent-from-lists` -> **NOT FOUND** in `.planning/REQUIREMENTS.md`
- `adhoc-publish-everywhere-shortcut` -> **NOT FOUND** in `.planning/REQUIREMENTS.md`

Result: **Gap found**. Plan frontmatter requirement IDs are not accounted for in `REQUIREMENTS.md`.

## Must-Have Verification Against Codebase

### Plan 01-01 must_haves

1. Truth: no user-editable series subtitle input
- Status: PASS
- Evidence:
  - `components/NewSeriesPopup.tsx` form state includes `name`, `summary`, `images` only; no subtitle field (`35-43`).
  - No subtitle input rendered; only Name + Summary fields (`216-232`).

2. Truth: subtitle always rendered as `<publishedCount> part series`
- Status: PASS
- Evidence:
  - Canonical helper format: `return `${safePublishedCount} part series`` in `functions/src/helpers/seriesHelpers.ts:25-27`.
  - Series admin page derives subtitle from published items: `pages/admin/series/[seriesId].tsx:602-603`, rendered at `748`.
  - Sermon page derives from series `publishedItemCount`: `pages/admin/sermons/[sermonId].tsx:477`, rendered at `750`.

3. Truth: published count excludes non-published items
- Status: PASS
- Evidence:
  - Strict boolean check only: `item.publishedToSubsplash === true` in `functions/src/helpers/seriesHelpers.ts:34-35`.
  - Listener normalizes to strict boolean before derivation in `functions/src/DocumentListeners/Series/seriesItemOnWrite.ts:23-26`.

4. Truth: unpublish from Subsplash updates series subtitle/count
- Status: PASS
- Evidence:
  - Unpublish sets `publishedToSubsplash: false` and clears `sermonSubsplashId` in `components/ManagePublishingPopup.tsx:235-237`, `256-258`.
  - Same clearing logic in sermon page flow: `pages/admin/sermons/[sermonId].tsx:403-404`, `421-422`.
  - Listener recalculates `itemCount`, `publishedItemCount`, and `subtitle` on series-item writes: `functions/src/DocumentListeners/Series/seriesItemOnWrite.ts:29-33`.

5. Artifact checks
- `components/NewSeriesPopup.tsx`: PASS (subtitle input removed)
- `functions/src/DocumentListeners/Series/seriesItemOnWrite.ts`: PASS (42 lines; canonical recalculation)
- `types/Series.ts`: PASS (`subtitle`, `publishedItemCount`, default `0 part series` at `31-35`)
- `functions/src/createSeries.ts`: PASS (no subtitle input in `CreateSeriesInputType`; derived init subtitle at `48`, `66`, `103`)
- `pages/admin/series/[seriesId].tsx`: PASS (strict `publishedToSubsplash` parsing at `286`, derived subtitle render)

### Plan 01-02 must_haves

1. Truth: series publishing is independent from list publishing
- Status: PASS
- Evidence:
  - `Publish to Series` gated by sermon media presence (`sermon.subsplashId`), not list publish state: `components/ManagePublishingPopup.tsx:708-717`, `718-721`.
  - Callable `addToSeries` has no list-state checks: `functions/src/addToSeries.ts:34-43`.

2. Truth: count increments only when `publishedToSubsplash === true`
- Status: PASS
- Evidence:
  - Strict counting in helper: `functions/src/helpers/seriesHelpers.ts:34-35`.
  - Listener uses helper-derived counts for series doc updates: `functions/src/DocumentListeners/Series/seriesItemOnWrite.ts:22-33`.

3. Truth: no fallback from `sermonSubsplashId`
- Status: PASS
- Evidence:
  - `deriveSeriesMetadata` only inspects `publishedToSubsplash`; no `sermonSubsplashId` fallback in counting logic.
  - Regression test for missing flag not counted: `functions/src/test/series/seriesMetadata.test.ts:100-111`.

4. Truth: one-click combined publish retained
- Status: PASS
- Evidence:
  - Combined flow implemented: `publishEverywhere` in `components/ManagePublishingPopup.tsx:496-542`.
  - Secondary button wiring: `secondaryButtonLabel='Publish Everywhere'` at `748-750`.
  - Partial failure messaging present (`529`, `534`, `538`).

5. Artifact checks
- `components/ManagePublishingPopup.tsx`: PASS (761 lines; independent + combined actions)
- `functions/src/helpers/seriesHelpers.ts`: PASS (265 lines; strict semantics)
- `scripts/backfillSeriesPublishedFlags.ts`: PASS (287 lines; dry-run default, `--apply` write mode, membership reconciliation)
- `docs/series-publish-workflow.md`: PASS (documents independent/combined flow + backfill)

## Requirement Coverage (SERIES-01..04)

1. `SERIES-01` (derived subtitle from explicit published state)
- Status: PASS
- Evidence: strict helper + listener (`functions/src/helpers/seriesHelpers.ts:30-42`, `functions/src/DocumentListeners/Series/seriesItemOnWrite.ts:21-33`), plus tests (`functions/src/test/series/seriesMetadata.test.ts`).

2. `SERIES-02` (series publish does not require list publish state)
- Status: PASS
- Evidence: UI + callable flow does not read list publication state (`components/ManagePublishingPopup.tsx:708-717`, `functions/src/addToSeries.ts:34-43`), addToSeries test (`functions/src/test/series/addToSeries.test.ts:52-70`).

3. `SERIES-03` (combined one-click flow preserved with independent actions)
- Status: PASS
- Evidence: dedicated `publishEverywhere` flow plus standalone list/series actions (`components/ManagePublishingPopup.tsx:496-550`, `731-751`).

4. `SERIES-04` (legacy flags reconciled without runtime fallback)
- Status: PASS
- Evidence: runtime strict logic in helper (`functions/src/helpers/seriesHelpers.ts:34-35`), backfill script for historical reconciliation (`scripts/backfillSeriesPublishedFlags.ts:148-282`), docs (`docs/series-publish-workflow.md:19-59`).

## Test Evidence Executed

- `cd functions && firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest --forceExit series/seriesMetadata.test.ts"` -> PASS (7 tests)
- `cd functions && firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest --forceExit series/addToSeries.test.ts"` -> PASS (13 tests)
- `cd functions && firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest --forceExit series/createSeries.test.ts"` -> PASS (18 tests)
- `cd functions && firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest --forceExit series"` -> PASS (6 suites, 65 tests)

Note: `cd functions && pnpm test -- series/seriesMetadata.test.ts` failed in this environment due argument forwarding via `firebase emulators:exec`; direct emulator+jest invocation succeeded.

## Gaps Found

1. **Requirement traceability mismatch (blocking for strict accounting):**
- Phase plan frontmatter uses `adhoc-*` IDs that do not exist in `.planning/REQUIREMENTS.md`.
- To close this gap, replace `adhoc-*` IDs in phase plan frontmatter with canonical `SERIES-01..SERIES-04` mappings.
