# Codebase Concerns

**Analysis Date:** 2026-02-24

## Tech Debt

**Large, multi-responsibility UI files:**
- Issue: Several admin pages/components are very large and blend data loading, state logic, and rendering.
- Evidence: `pages/admin/series/[seriesId].tsx` (~1071 lines), `pages/admin/sermons/[sermonId].tsx` (~857), `components/uploaderComponents/UploaderComponent.tsx` (~901).
- Impact: Higher regression risk and harder reasoning/refactoring.
- Fix approach: Split by feature hooks and presentational subcomponents; extract data orchestration into composable hooks.

**Legacy function retained alongside current logic:**
- Issue: `functions/src/old_addToList.ts` still exists while `functions/src/addToList.ts` is active.
- Impact: Confusion during maintenance and risk of stale behavior assumptions.
- Fix approach: Confirm no runtime references, archive/remove legacy implementation, keep migration notes in docs.

**Outstanding TODOs in operational paths:**
- Issue: TODO markers in upload/publish flows (e.g., image subsplash requirements and role request form behavior).
- Evidence: `pages/api/uploadFile.tsx`, `components/RequestUploadPrivalige.tsx`, `components/uploaderComponents/UploaderComponent.tsx`.
- Impact: Incomplete UX and potential runtime hard-fail paths.
- Fix approach: Convert TODOs into tracked tasks with acceptance criteria and remove dead branches.

## Known Bugs

**Trimmer/debug noise and possible production leakage risk:**
- Symptoms: Debug logging and debug route writes can remain active depending on env flags.
- Evidence: `utils/trimmerDebug.ts`, `pages/api/debug/trimmer.ts`, plus performance note in `docs/PERFORMANCE_SWEEP_2026-02-23.md`.
- Workaround: Disable debug env flags in production.
- Root cause: Mixed debug toggles and permissive non-production gating.

**Performance bottlenecks on admin sermons route:**
- Symptoms: High render-delay dominated LCP and CLS spikes.
- Evidence: `docs/PERFORMANCE_SWEEP_2026-02-23.md` (open high-priority findings).
- Impact: Slower admin workflow and reduced perceived responsiveness.
- Fix approach: Virtualize list rendering, reduce initial work, stabilize layout shifts.

## Security Considerations

**Credential style for Subsplash auth:**
- Risk: Username/password env auth (`EMAIL`/`PASSWORD`) is higher-risk operationally than scoped service credentials.
- Current mitigation: Environment-based secrets (not hardcoded in source).
- Recommendations: Move to managed secrets and scoped credentials with rotation policy; avoid plain credential naming in broad env usage.

**Potential token/cookie handling fragility:**
- Risk: Auth depends on cookie token verification in server-side route helpers (`components/ProtectedRoute.tsx`).
- Current mitigation: Firebase Admin token verification + role checks.
- Recommendations: Add explicit token expiry/refresh behavior tests and centralize auth guard usage.

## Performance Bottlenecks

**Admin sermons list rendering:**
- Problem: Largest observed route bottleneck.
- Measurement: Recent documented traces show ~4.4s-4.8s LCP with high render delay and CLS ~0.19.
- Cause: Heavy initial render workload and expensive page composition.
- Improvement path: Virtualization, deferred secondary panels, strict memoization and request batching.

**Forced reflow hotspots in player/trimmer UI:**
- Problem: Resize/reflow cost around media interactions.
- Evidence: `docs/PERFORMANCE_SWEEP_2026-02-23.md` + trimmer/player complexity in `components/trimmer/*`, `components/BottomAudioBar.tsx`.
- Improvement path: throttle resize logic and reduce layout-read-after-write behavior.

## Fragile Areas

**Add-to-list overflow and ordering semantics:**
- Why fragile: Complex transaction and external API coordination across Firestore + Subsplash list rows.
- Files: `functions/src/addToList.ts`, `functions/src/helpers/addToListHelpers.ts`.
- Common failures: duplicates, ordering drift, overflow link chain issues under retries/concurrency.
- Safe modification: maintain emulator-backed concurrency tests before and after changes.

**Trimmer synchronization stack:**
- Why fragile: Multiple synchronization points (player adapter, Zustand store, drag/input timelines).
- Files: `components/YouTubeTrimmer.tsx`, `components/trimmer/useTrimmerSync.ts`, `context/trimmerStore.ts`.
- Common failures: loading state hangs, scrub/playhead desync, mobile interaction edge cases.
- Safe modification: preserve E2E coverage and add focused regression tests for touched interactions.

## Scaling Limits

**Function/API fanout during admin flows:**
- Current capacity risk: per-item or repeated callable patterns can increase latency/cost on large datasets.
- Symptoms at limit: slower admin interactions, elevated function invocation volume.
- Scaling path: batch endpoints and denormalized read models for heavy admin lists.

**Firestore/list complexity growth:**
- Risk: nested list and series mutation complexity scales with content volume.
- Symptoms: transaction contention and slower consistency updates.
- Scaling path: stronger bounded contexts and asynchronous reconciliation jobs for non-critical updates.

## Dependencies at Risk

**Media toolchain complexity:**
- Risk: ffmpeg/imagemagick/sharp stack is operationally heavy and environment-sensitive.
- Impact: local/prod parity issues and deployment constraints.
- Migration plan: standardize processing pipeline and add health checks around external binaries.

**Legacy mixed integration patterns:**
- Risk: coexistence of older and newer endpoints/helpers increases maintenance burden.
- Impact: accidental use of stale logic during feature work.
- Migration plan: formal deprecation pass with removal checklist.

## Missing Critical Features

**Unified CI quality gate for full stack:**
- Problem: no repository-level CI workflow files were detected for mandatory lint/test/build gates.
- Current workaround: manual local command execution.
- Blocks: consistent pre-merge quality guarantees.
- Implementation complexity: medium.

**Client unit/component test layer:**
- Problem: strong functions tests + E2E exist, but React component-level automated tests are sparse.
- Current workaround: E2E coverage for critical paths.
- Blocks: fast feedback for UI regressions.
- Implementation complexity: medium.

## Test Coverage Gaps

**High-complexity UI pages/components:**
- What's not tested enough: granular behavior in largest admin pages/components.
- Risk: regressions hidden until manual QA or E2E failures.
- Priority: High.
- Difficulty: Medium-high due to current component size and side effects.

**Security/error handling edge paths for integrations:**
- What's not tested enough: credential failure, token rotation, partial external API outage behavior.
- Risk: operational incidents and incomplete rollback behavior.
- Priority: Medium.
- Difficulty: Medium.

---

*Concerns audit: 2026-02-24*
*Update as performance/security/tech-debt items are resolved or discovered*
