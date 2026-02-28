# Codebase Concerns (Focused Map)

## Priority Legend
- P0: security or data-integrity risk with immediate blast radius
- P1: high reliability/performance risk that can cause incidents or chronic regressions
- P2: maintainability/operational debt with medium-term delivery drag
- P3: lower-severity quality issues

## P0 Concerns
1. Unauthenticated mutation-capable Cloud Functions are exposed.
   - Evidence: `functions/src/Scrapers/fixPhantomListItems.ts` (`onRequest` + `cors: true`), `functions/src/Scrapers/updateSubsplashTag.ts` (`onRequest` + `cors: true`), `functions/src/helpers/updateImageMetadata.ts` (`onRequest`), `functions/src/Scrapers/tagItemsInList.ts` (`onCall` with no `request.auth` guard), `functions/src/updateCreatedAndEditedAtMillis.ts` (`onCall` with no auth), `functions/src/addIntroOutro/addintrooutrotaskgenerator.ts` (`onCall` with no auth), `functions/src/generateAlgoliaSecureApiKey.ts` (no auth guard).
   - Risk: internet callers can trigger expensive jobs, mutate Firestore state, enqueue audio processing work, and generate API keys for arbitrary users.
   - Why fragile: auth checks are inconsistent across functions; some endpoints enforce role, others do not.

2. Authorization surface is overly permissive in rules.
   - Evidence: `firestore.rules` allows any authenticated user to read/write `users/{userId}`; `/{path=**}/listItems/{listItemId}` and `/{path=**}/sermonLists/{sermonListId}` allow broad write for any upload-capable role.
   - Evidence: `storage.rules` allows global `read` on all objects.
   - Evidence: `database.rules.json` sets `".read": true` globally.
   - Risk: cross-user data tampering and broad data visibility beyond least-privilege assumptions.

3. Dev/prod safety bug in emulator wiring for Realtime Database.
   - Evidence: `firebase/database.ts` checks `process.env.FIRESTORE_EMULATOR_STARTED` before `connectDatabaseEmulator`; `firebase/firestore.ts` sets that flag first.
   - Risk: local dev may silently read prod RTDB while Firestore/Auth are on emulator, creating high-risk mixed-environment behavior.

## P1 Concerns
4. Batch write reliability bugs (unawaited commits / incorrect batch lifecycle).
   - Evidence: `functions/src/helpers/updateImageMetadata.ts` calls final `batch.commit()` without `await`.
   - Evidence: `functions/src/updateCreatedAndEditedAtMillis.ts` calls `batch.commit()` inside `forEach` without `await` and keeps reusing same batch.
   - Evidence: `functions/src/Scrapers/tagItemsInList.ts` calls `batch.commit()` without `await` (both loop and final commit).
   - Risk: partial writes, silent data drift, and difficult postmortem analysis.

5. High fan-out listeners with full scans on hot paths.
   - Evidence: `functions/src/DocumentListeners/Sermons/sermonWriteTrigger.ts` updates every matching `listItems` doc on sermon edits.
   - Evidence: `functions/src/DocumentListeners/Lists/listOnUpdate.ts` propagates list updates to all `sermonLists` references.
   - Evidence: `functions/src/DocumentListeners/Series/seriesItemOnWrite.ts` re-reads entire `series/{seriesId}/seriesItems` collection on each write.
   - Risk: high write amplification, function timeout/cost spikes as data grows.

6. Bundle regeneration is too eager for topics.
   - Evidence: `shared/bundleConfigs.ts` sets `TOPIC_BUNDLE_CONFIG.shouldTrigger: () => true`.
   - Evidence: `functions/src/utils/bundleListenerUtils.ts` regenerates full bundles via `generateAndStoreBundle` on each trigger.
   - Risk: unnecessary full collection scans + bundle rebuilds for low-signal updates (cost and latency pressure).

7. Admin route protection is primarily client-side and inconsistent.
   - Evidence: `utils/protectedRoutes.ts` + `components/ProtectedRoute.tsx` exist, but admin pages rely on client checks (`useAuth`) and commented SSR guards (`pages/admin/users.tsx`, `pages/admin/lists/[listId].tsx`).
   - Evidence: `layout/AppLayout.tsx` performs `router.push` during render instead of an effect.
   - Risk: fragile auth UX, blank-page behavior, and avoidable route flicker/access ambiguity.

8. Current measured UI hotspots remain unresolved in production-like flows.
   - Evidence: `docs/PERFORMANCE_SWEEP_2026-02-23.md` still reports high render-delay LCP/CLS on `/admin/sermons`.
   - Evidence: `components/SearchableAdminSermonsList.tsx` and related admin list views still execute large client rendering paths.
   - Risk: persistent slow admin workflows and operator friction.

## P2 Concerns
9. Repository contains very large tracked fixture/export payloads.
   - Evidence: tracked exports in `dir/` (Firestore/Auth/Storage emulator imports) and large scraper payloads in `scrapers/` (multi-MB to tens-of-MB JSON).
   - Evidence: `package.json` includes `import-from-prod` workflow writing into `./dir`.
   - Risk: slow clone/CI, accidental sensitive dataset churn, difficult review diffs.

10. Monolithic files are accumulating orchestration logic.
   - Evidence: `pages/admin/series/[seriesId].tsx` (~1088 LOC), `components/uploaderComponents/UploaderComponent.tsx` (~901 LOC), `pages/admin/sermons/[sermonId].tsx` (~876 LOC), `components/ManagePublishingPopup.tsx` (~670 LOC).
   - Risk: regression-prone edits, weak component boundaries, and high review burden.

11. Cross-layer coupling via `pages/api` utility imports is confusing and brittle.
   - Evidence: client components import local app logic from `pages/api/*` (`components/uploaderComponents/UploadButton.tsx`, `components/NewListPopup.tsx`, `components/uploaderComponents/UploaderComponent.tsx`).
   - Evidence: files in `pages/api` (`pages/api/uploadFile.tsx`, `pages/api/editSermon.ts`, `pages/api/addNewList.ts`) are not conventional Next API handlers.
   - Risk: unclear route surface, accidental runtime exposure, and maintenance confusion.

12. External integration configuration is hard-coded in multiple places.
   - Evidence: `utils/createFunction.ts` hard-codes Cloud Run host pattern (`https://${name}-yshbijirxq-uc.a.run.app`).
   - Evidence: `functions/src/addIntroOutro/addintrooutrotaskgenerator.ts` hard-codes `https://process-audio-yshbijirxq-uc.a.run.app/process-audio`.
   - Risk: environment drift and brittle deploy portability.

13. Subsplash integration uses direct credential flow from env vars.
   - Evidence: `functions/src/subsplashUtils.ts` reads `process.env.EMAIL` / `process.env.PASSWORD` and performs password grant.
   - Risk: secrets lifecycle and rotation posture weaker than Secret Manager-based patterns.

14. `listUsers` strategy is unbounded and non-paginated in UI path.
   - Evidence: `functions/src/listUsers.ts` recursively reads all users; `pages/admin/users.tsx` fetches full set at load.
   - Risk: scale ceiling and long-latency admin page initialization.

## P3 Concerns
15. Test/verification pipeline coverage is uneven.
   - Evidence: no CI workflow file under `.github/workflows`; root scripts emphasize e2e but no broad unit/integration command.
   - Evidence: exposed function auth behaviors above have no visible dedicated tests.
   - Risk: regressions in auth/perf areas are likely to reach manual QA.

16. Docs and legacy artifacts show drift.
   - Evidence: root `README.md` is mostly default Next starter text and does not reflect actual workflows.
   - Evidence: legacy/stale subtree `youtube-to-mp3-cloud-run/` (template-style README, older runtime assumptions) coexists with current add-intro/outro pipeline.
   - Risk: onboarding confusion and duplicated mental models.

17. Minor routing/UX consistency issues remain.
   - Evidence: `pages/profile.tsx` uses `callbackUrl` while login logic expects `callbackurl`.
   - Evidence: `components/RequestUploadPrivalige.tsx` is explicitly TODO/non-functional.
   - Risk: inconsistent navigation behavior and incomplete admin access workflow.

## Suggested Order of Remediation
1. Lock down unauthenticated function surfaces and tighten rules (`firestore.rules`, `storage.rules`, `database.rules.json`).
2. Fix batch-commit correctness bugs and add regression tests around write completion semantics.
3. Repair emulator wiring (`firebase/database.ts`) to eliminate mixed dev/prod access risk.
4. Reduce fan-out and bundle regeneration pressure (delta-based triggers + throttling).
5. Break monolith files into smaller modules and remove `pages/api` utility misplacement.
6. Rationalize operational assets (`dir/`, `scrapers/`, stale subsystems) and document canonical workflows.
