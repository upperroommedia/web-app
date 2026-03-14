---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Publishing Reliability + Dev Safety
current_phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model
status: blocked
last_updated: "2026-03-14T21:23:07Z"
last_activity: 2026-03-14 - Executed phase 06 plan 04 root-detail overflow aggregation and diagnostics, but git metadata writes remain blocked by .git/index.lock permission errors
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 25
  completed_plans: 18
---

# Session State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-28)

**Core value:** Trustworthy end-to-end publishing pipeline for admins
**Current focus:** Phase 06 root-detail overflow aggregation is implemented in the worktree, but commit/state completion is blocked by git metadata write restrictions.

## Position

**Milestone:** v1.0 Publishing Reliability + Dev Safety
**Current phase:** 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model
**Status:** Blocked on git metadata writes
**Last activity:** 2026-03-14 - Executed phase 06 plan 04 root-detail overflow aggregation and diagnostics, but `.git/index.lock` creation failed during commit attempts

## Decisions

- Continue treating this repository as a brownfield platform with pre-existing validated capabilities.
- Use refreshed `.planning/codebase/*.md` as grounding for project-level docs and future milestone planning.
- [Phase 01-series-subtitle-automation]: Series published counts remain strict and ignore inferred fallback state.
- [Phase 01-series-subtitle-automation]: Backfill runs dry-run by default and requires explicit --apply for writes.
- [Phase 01-series-subtitle-automation]: Series verification used direct emulator+jest commands because pnpm test argument forwarding remained unreliable.
- [Quick 2 immediate redirect]: Delete confirm now redirects immediately and executes delete once in `/admin/sermons` via intent payload.
- [Phase 03-subsplash-alpha-lock-concurrency-control]: Lock rows are stored in RTDB under subsplashLocks/{encodedLockKey} with lease-based ownership and stale takeover.
- [Phase 03-subsplash-alpha-lock-concurrency-control]: Release failures always log structured Cloud Logging events and persist fallback records in Firestore lockReleaseFailures.
- [Phase 03-subsplash-alpha-lock-concurrency-control]: Failed idempotency records are reclaimable for retries and explicitly clear stale success payloads before re-execution.
- [Phase 03-subsplash-alpha-lock-concurrency-control]: Required operationKey on upload/edit/delete and lockKey on upload before remote mutations.
- [Phase 03-subsplash-alpha-lock-concurrency-control]: Wrapped sermon media mutations with withIdempotency outside withSubsplashLocks to replay duplicate operations without rerunning side effects.
- [Phase 03-subsplash-alpha-lock-concurrency-control]: Updated shared firebase https test mocks to support both onCall signatures and HttpsError.details for deterministic lock-suite assertions.
- [Phase 03]: addToList/removeFromList now return per-list lock contention metadata while preserving partial-success array semantics.
- [Phase 03]: createNewSubsplashList now serializes duplicate title-based creates with deterministic list:create-<slug> lock keys and optional operation-key replay.
- [Phase 03]: Series callables now use idempotency as an outer wrapper and lock scopes as inner execution guards.
- [Phase 03]: Series mutation input interfaces keep operationKey optional with generated fallback keys for backwards-compatible callers.
- [Phase 03]: Busy contention contract validation combines deterministic operation-key in-progress claims with explicit lock-timeout assertions.
- [Phase 03]: Caller retries remain user-triggered; lock busy responses provide retry_after_ms guidance only.
- [Phase 03]: Operation-key generation is centralized in utils/callableConcurrency.ts and reused across UI/API call sites.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Role-request and runtime-alert recipients are environment-configurable via firebase-functions params with production-safe defaults.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Operational alert helper intentionally enqueues one email per invocation with no dedupe suppression window.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Notification outbox docs include structured meta fields (source, alertType, alertCode) while remaining Trigger Email compatible.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Runtime alert codes are function-specific and deterministic for all targeted catch paths.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Add-intro/outro catch blocks wrap alert emission failures so existing status/error handling remains intact.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Role-request writes remain authoritative even when outbound notification enqueue fails.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Duplicate pending requests for the same requester/role return existing request metadata and skip re-queue.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Role request callable must be exported from functions index to be deployable.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Invite artifacts persist sha256 token hashes only; raw invite tokens are never stored.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Invite claim retries are allowed only from ROLE_FAILED and only for the original claimant uid/email.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Final claimed role resolves via ROLE_PRECEDENCE and merges existing custom claims before refresh-token revocation.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Exported createrolerequest/createinvite/claiminvite with lower-case keys for v2 callable URL compatibility.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Implemented admin invite issuance in users toolbar dialog without altering user-table sorting/pagination behavior.
- [Phase 04-role-based-invite-onboarding-and-operational-notification-routing]: Login now honors callbackurl and callbackUrl aliases while only allowing local callback paths.
- [Phase 03]: bulkaddtoseries now requires operationKey and expectedPublishedMembershipHash to enforce deterministic replay and stale-snapshot protection
- [Phase 03]: bulkaddtoseries lock scope uses series:{firestoreSeriesId} plus sorted media-item lock keys for cross-callable serialization
- [Phase 03]: series admin bulk publish retries now derive deterministic createRetryIntentKey values from intent fingerprints
- [Phase 03-subsplash-alpha-lock-concurrency-control]: Series-list delete callables now include deterministic operationKey payloads and lock-busy retry guidance.
- [Phase 03-subsplash-alpha-lock-concurrency-control]: deleteSermonWithExternalCleanup now fails fast and preserves callable code/details via ExternalCleanupError for UI contention handling.
- [Phase 03-subsplash-alpha-lock-concurrency-control]: LOCK-01..LOCK-05 definitions and traceability rows are restored as complete in REQUIREMENTS.md.
- [Phase 05-speaker-management-crud-admin-create-speaker-popup-with-optional-speaker-list-association]: Speaker CRUD uses separate createspeaker/updatespeaker/deletespeaker callables with shared validation/mutation helpers.
- [Phase 05-speaker-management-crud-admin-create-speaker-popup-with-optional-speaker-list-association]: List side effects are explicit booleans only: createSpeakerList for create/update and deleteAssociatedList for delete.
- [Phase 05-speaker-management-crud-admin-create-speaker-popup-with-optional-speaker-list-association]: Speaker-list creation reuses createNewSubsplashList and persists Firestore ListType.SPEAKER_LIST linked via speaker.listId.
- [Phase 05]: Use createFunctionV2('createspeaker') from pages/admin/speakers.tsx and keep popup as a reusable form component.
- [Phase 05]: Treat required speaker-list success copy/link as constants exported from a single helper and reuse those in UI.
- [Phase 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model]: Discovery treats explicit isRootList metadata as authoritative when present and falls back to legacy isMoreSermonsList exclusion until brownfield rollout verification completes.
- [Phase 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model]: Admin list discovery renders logicalCount ?? count and overflow badges via hasOverflowPages with moreSermonsRef fallback for legacy records.
- [Phase 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model]: Admin list discovery exposes only name sorting until truthful logical-total Algolia replicas exist.
- [Phase 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model]: Root detail resolves `getlistoverflowchain` before Firestore reads and redirects overflow routes to the logical root immediately.
- [Phase 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model]: Aggregated root detail renders only locally mirrored `listItems` rows and treats chain diagnostics or mirror gaps as read-only state.
- [Phase 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model]: Overflow-chain root detail remains inspect-only until chain-aware reorder persistence is delivered in plan 06-05.

## Accumulated Context

### Roadmap Evolution

- Phase 3 added: Subsplash alpha-lock concurrency control
- Phase 4 added: Role-based invite onboarding and operational notification routing
- Phase 5 added: Speaker management CRUD + admin create speaker popup with optional speaker list association
- Phase 6 added: Add-to-list overflow chain hardening and nested list admin model

## Blockers

- Plan 06-03 cannot be fully completed in GSD terms because this environment denies writes under `.git/` (`fatal: Unable to create '.git/index.lock': Operation not permitted`), preventing atomic task commits and the final docs commit.
- Plan 06-04 cannot be fully completed in GSD terms for the same reason: local git metadata writes are denied under `.git/`, so required task commits and the final docs commit cannot be created.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 1 | Prevent sermon counter overwrites in edit writes | 2026-03-01 | 5b7b798 | [1-prevent-sermon-counter-overwrites-in-edi](./quick/1-prevent-sermon-counter-overwrites-in-edi/) |
| 2 | Immediately redirect to admin sermons after delete confirm; execute delete in destination with toast lifecycle | 2026-03-01 | d58a190 | [2-immediately-redirect-to-admin-sermons-af](./quick/2-immediately-redirect-to-admin-sermons-af/) |

## Session Log

- 2026-02-28: STATE.md regenerated by /gsd:health --repair.
- 2026-02-28: Ran $gsd-map-codebase refresh and regenerated all seven codebase mapping docs.
- 2026-02-28: Expanded PROJECT.md, REQUIREMENTS.md, and ROADMAP.md to represent full platform context.
- 2026-02-28: Completed 01-series-subtitle-automation/01-02 with atomic task commits and summary.
- 2026-03-01: Completed quick task 1 (sermon counter overwrite prevention + invariant auto-recalc guard).
- 2026-03-01: Completed quick task 2 (immediate details-page redirect to `/admin/sermons`, one-shot delete execution, progress/success/error toasts).
- 2026-03-01: Completed 03-subsplash-alpha-lock-concurrency-control/03-01 with lock/idempotency primitives and emulator lock-layer tests.
- 2026-03-01: Completed 03-subsplash-alpha-lock-concurrency-control/03-02 with series mutation lock/idempotency wrappers and contention/replay regression coverage.
- 2026-03-01: Completed 03-subsplash-alpha-lock-concurrency-control/03-04 with sermon/media mutation lock wrappers and regression coverage.
- 2026-03-01: Completed 03-subsplash-alpha-lock-concurrency-control/03-03 with list mutation lock/idempotency wrappers and replay regression coverage.
- 2026-03-01: Completed 03-subsplash-alpha-lock-concurrency-control/03-05 with caller operation-key propagation, lock-busy retry guidance, and client contract tests.
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-01 with notification params, queue helpers, and emulator regression tests.
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-05 with publish/audio catch-path operational alert rollout and runtime regression coverage.
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-02 with persistence-first role request callable, queue-failure fallback, and emulator regression coverage.
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-03 with secure invite issue/claim callables and emulator lifecycle regression coverage.
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-04 with callable export wiring, admin invite UX, and invite claim onboarding routes.
- 2026-03-08: Completed 03-subsplash-alpha-lock-concurrency-control/03-06 with bulkAddToSeries lock/idempotency migration, stale-snapshot guard, and caller intent-scoped retry keys.
- 2026-03-08: Completed 03-subsplash-alpha-lock-concurrency-control/03-07 with delete caller operation-key adoption, lock-busy retry UX wiring, and LOCK requirements traceability restoration.
- 2026-03-10: Completed 05-speaker-management-crud-admin-create-speaker-popup-with-optional-speaker-list-association/05-01 with separate createspeaker/updatespeaker/deletespeaker callables, shared speaker mutation orchestration, and emulator CRUD regression coverage.
- 2026-03-10: Completed 05-speaker-management-crud-admin-create-speaker-popup-with-optional-speaker-list-association/05-02 with admin add-speaker popup create flow, createspeaker callable wiring, and required list-success copy/link contract enforcement.
- 2026-03-14: Added Phase 06 for add-to-list overflow chain hardening and nested list admin model.
- 2026-03-14: Executed 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model/06-03 worktree changes and passed targeted Jest + ESLint verification, but `.git/index.lock` permission failures blocked required commits and plan completion.
- 2026-03-14: Executed 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model/06-04 worktree changes and passed targeted Jest + ESLint verification, but `.git/index.lock` permission failures again blocked required commits and plan completion.
