---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Publishing Reliability + Dev Safety
current_phase: 04-role-based-invite-onboarding-and-operational-notification-routing
status: executing
last_updated: "2026-03-01T09:19:42.565Z"
last_activity: 2026-03-01 - Completed phase 04 plan 04 UI wiring for invite and role-request flows
progress:
  total_phases: 3
  completed_phases: 2
  total_plans: 12
  completed_plans: 11
---

# Session State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-28)

**Core value:** Trustworthy end-to-end publishing pipeline for admins
**Current focus:** Phase 04 notification foundation rollout for invite onboarding and operational alert routing

## Position

**Milestone:** v1.0 Publishing Reliability + Dev Safety
**Current phase:** 04-role-based-invite-onboarding-and-operational-notification-routing
**Status:** Complete (04-01, 04-02, 04-03, 04-04, and 04-05 complete)
**Last activity:** 2026-03-01 - Completed phase 04 plan 04 UI wiring for invite and role-request flows

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

## Accumulated Context

### Roadmap Evolution

- Phase 3 added: Subsplash alpha-lock concurrency control
- Phase 4 added: Role-based invite onboarding and operational notification routing

## Blockers

- None recorded in state file.

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
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-01 with notification params, queue helpers, and emulator regression tests.
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-05 with publish/audio catch-path operational alert rollout and runtime regression coverage.
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-02 with persistence-first role request callable, queue-failure fallback, and emulator regression coverage.
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-03 with secure invite issue/claim callables and emulator lifecycle regression coverage.
- 2026-03-01: Completed 04-role-based-invite-onboarding-and-operational-notification-routing/04-04 with callable export wiring, admin invite UX, and invite claim onboarding routes.
