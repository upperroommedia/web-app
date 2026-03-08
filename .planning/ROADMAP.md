# Roadmap: Upper Room Media Web App

## Overview

This roadmap tracks active GSD-managed work on top of an already substantial brownfield product. Core platform capabilities (auth, content domains, media processing, external publishing, search, and bundles) are already in production use. Current GSD phases focus on publishing correctness and development safety, followed by hardening candidates informed by the refreshed codebase concerns map.

## Milestones

- ✅ **Pre-GSD Product Foundation** - Existing platform capabilities established before current planning cycle
- 🚧 **v1.0 Publishing Reliability + Dev Safety** - Phases 1-4 (in progress)
- 📋 **v1.1 Platform Hardening (Candidate)** - Security/reliability simplification work to be phased next

## Phases

- [x] **Phase 1: Series Subtitle Automation** - Finalize canonical series publish metadata and publish UX behavior.
- [ ] **Phase 2: Dev External API Mocking** - Enforce fail-closed local external API policy with deterministic mocks.
- [x] **Phase 3: Subsplash Alpha-Lock Concurrency Control** - Prevent stale-write races across Subsplash-linked mutation paths.
- [x] **Phase 4: Role-Based Invite Onboarding + Notification Routing** - Add invite onboarding and centralized notification/operational alert infrastructure.

## 🚧 v1.0 Publishing Reliability + Dev Safety

## Phase Details

### Phase 1: Series Subtitle Automation
**Goal:** Enforce canonical series subtitle/count semantics and complete independent/combined series publishing UX.
**Depends on:** Nothing (first phase)
**Requirements:** [SERIES-01, SERIES-02, SERIES-03, SERIES-04]
**Success Criteria** (what must be TRUE):
  1. Series subtitle always resolves to `<publishedCount> part series`.
  2. Published series count is derived from explicit `publishedToSubsplash === true` state only.
  3. Series publish action is independent from list publish state.
  4. One-click combined publish still works without removing independent publish actions.
**Plans:** 2 plans

Plans:
- [x] 01-01: Remove manual subtitle input and add canonical metadata recalculation path
- [x] 01-02: Decouple publish gating, add combined flow, and backfill strict publish flags

### Phase 2: Dev External API Mocking
**Goal:** Guarantee local dev and emulator flows do not call production Subsplash/SoundCloud endpoints.
**Depends on:** Phase 1
**Requirements:** [DEVSAFE-01, DEVSAFE-02, DEVSAFE-03, DEVSAFE-04]
**Success Criteria** (what must be TRUE):
  1. Emulator mode blocks outbound requests to production Subsplash/SoundCloud hosts.
  2. Local workflows run with deterministic mock responses for external integrations.
  3. Misconfigured mode fails closed with actionable operator feedback.
  4. Tests/static checks enforce the policy against regression.
**Plans:** 1 plan

Plans:
- [ ] 02-01: Implement external API mode policy, provider mocks, and guardrail tests/docs

## Upcoming Scope Candidates (Not Yet Phased)

- Function auth hardening and permission boundary cleanup (from `CONCERNS.md` P0 findings)
- Firestore/Storage/RTDB rules tightening for least-privilege defaults
- Batch-write reliability fixes and listener cost reduction work
- Decomposition of large admin modules and cleanup of mixed `pages/api` utility patterns
- CI/testing coverage expansion for high-risk backend and admin flows

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Series Subtitle Automation | 2/2 | Complete | 2026-02-28 |
| 2. Dev External API Mocking | 0/1 | In progress | - |
| 3. Subsplash alpha-lock concurrency control | 7/7 | Complete | 2026-03-08 |
| 4. Role-based invite onboarding and operational notification routing | 5/5 | Complete | 2026-03-01 |

### Phase 3: Subsplash alpha-lock concurrency control

**Goal:** Enforce lock-based, idempotent concurrency safety for all Subsplash-linked series/list/sermon mutation callables so stale reads cannot overwrite newer writes.
**Requirements**: [LOCK-01, LOCK-02, LOCK-03, LOCK-04, LOCK-05]
**Depends on:** Phase 2
**Success Criteria** (what must be TRUE):
  1. Mutation callables acquire deterministic entity locks (`series`, `list`, `media-item`) before any read that decides writes.
  2. Lock contention waits up to 10 seconds, then returns structured busy details (`code`, `locked_keys`, `wait_ms`, `retry_after_ms`).
  3. Mutation retries are idempotent via per-operation keys and do not duplicate side-effects.
  4. Lock release is enforced in finally paths with dead-letter/error logging for release failures.
  5. Admin caller flows propagate operation keys and handle busy responses with explicit retry UX.
**Plans:** 7 plans

Plans:
- [x] 03-01: Build shared RTDB lock/idempotency primitives with contention contract and lock-layer tests
- [x] 03-02: Migrate series mutation callables to lock + idempotency wrappers
- [x] 03-03: Migrate list mutation callables to lock + idempotency wrappers
- [x] 03-04: Migrate sermon/media mutation callables to lock + idempotency wrappers
- [x] 03-05: Wire admin callers to operation keys and lock-busy retry handling
- [x] 03-06: Enforce lock/idempotency/stale-snapshot contract for bulkAddToSeries and caller retry intent propagation
- [x] 03-07: Final verification sweep and cleanup for phase transition readiness

### Phase 4: Role-based invite onboarding and operational notification routing

**Goal:** Deliver role-based invite onboarding, role-request notification routing, and centralized operational runtime alerting with environment-configurable recipients.
**Requirements**: [INVITE-01, INVITE-02, INVITE-03, ROLE-REQ-01, ROLE-REQ-02, OPS-ALERT-01, OPS-ALERT-02]
**Depends on:** Phase 3
**Success Criteria** (what must be TRUE):
  1. Admins can issue role-targeted invite links that are single-use, email-bound, and expire after 30 days.
  2. Invite claims assign roles immediately, preserve highest existing role, and land users on a dedicated success route.
  3. New role requests persist and trigger environment-configurable notifications containing requester identity, target role, timestamp, and admin link.
  4. Notification failures do not roll back role-request writes and emit operational alert/log signals.
  5. Caught runtime failures in upload/audio and related publish flows emit email + structured alert events for every occurrence.
**Plans:** 5 plans

Plans:
- [x] 04-01-PLAN.md — Build notification params, Firestore outbox queue, and shared operational alert utility
- [x] 04-02-PLAN.md — Implement persistence-first role request callable with notification fallback and tests
- [x] 04-03-PLAN.md — Implement secure invite issue/claim backend with hashed tokens and no-downgrade role assignment
- [x] 04-04-PLAN.md — Wire new callables into exports and UI flows (admin invite, request form, invite claim/success routes)
- [x] 04-05-PLAN.md — Roll out runtime alert emission across publish and add-intro/outro catch paths with regression tests
