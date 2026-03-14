# Roadmap: Upper Room Media Web App

## Overview

This roadmap tracks active GSD-managed work on top of an already substantial brownfield product. Core platform capabilities (auth, content domains, media processing, external publishing, search, and bundles) are already in production use. Current GSD phases focus on publishing correctness and development safety, followed by hardening candidates informed by the refreshed codebase concerns map.

## Milestones

- ✅ **Pre-GSD Product Foundation** - Existing platform capabilities established before current planning cycle
- 🚧 **v1.0 Publishing Reliability + Dev Safety** - Phases 1-6 (in progress)
- 📋 **v1.1 Platform Hardening (Candidate)** - Security/reliability simplification work to be phased next

## Phases

- [x] **Phase 1: Series Subtitle Automation** - Finalize canonical series publish metadata and publish UX behavior.
- [ ] **Phase 2: Dev External API Mocking** - Enforce fail-closed local external API policy with deterministic mocks.
- [x] **Phase 3: Subsplash Alpha-Lock Concurrency Control** - Prevent stale-write races across Subsplash-linked mutation paths.
- [x] **Phase 4: Role-Based Invite Onboarding + Notification Routing** - Add invite onboarding and centralized notification/operational alert infrastructure.
- [x] **Phase 5: Speaker Management CRUD + Admin Create Speaker Popup with Optional Speaker List Association** - Deliver speaker CRUD callables plus the admin create-speaker popup flow.
- [ ] **Phase 6: Add-to-List Overflow Chain Hardening and Nested List Admin Model** - Keep overflow chains root-only, chain-aware, and safe across admin workflows.

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
**Plans:** 2 plans

Plans:
- [ ] 02-01-PLAN.md — Implement external API mode policy and deterministic provider mock contracts
- [ ] 02-02-PLAN.md — Wire publish callables to policy-aware adapters and add endpoint guardrail regression test

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
| 5. Speaker Management CRUD + Admin Create Speaker Popup with Optional Speaker List Association | 2/2 | Complete | 2026-03-10 |
| 6. Add-to-list overflow chain hardening and nested list admin model | 2/7 | Blocked (git metadata writes; 06-03/04/05/07 worktree-only) | - |

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

### Phase 5: Speaker Management CRUD + Admin Create Speaker Popup with Optional Speaker List Association

**Goal:** Deliver backend speaker CRUD commands plus an admin add-speaker popup flow with optional speaker-list creation and exact success guidance.
**Requirements**: [SPK-01, SPK-02, SPK-03, SPK-04, SPK-05, SPK-06, SPK-07]
**Depends on:** Phase 4
**Success Criteria** (what must be TRUE):
  1. Admin speaker management is available through backend callable command(s) that support create, update, and delete.
  2. `/admin/speakers` shows a top-level Add Speaker button.
  3. Clicking Add Speaker opens a popup with complete speaker info inputs and image selection.
  4. Popup submit supports optional speaker-list creation and speaker/list association in one flow.
  5. Selected images are passed through and square image is used for both speaker tag and speaker list payloads.
  6. When speaker list creation succeeds, UI shows the exact Subsplash link and exact required instruction copy.
**Plans:** 2 plans

Plans:
- [x] 05-01-PLAN.md — Implement backend `createspeaker`/`updatespeaker`/`deletespeaker` callables with optional speaker-list association and square-image contract tests
- [x] 05-02-PLAN.md — Add admin Speakers top-button popup flow, callable wiring, and exact success popup link/instruction contract

### Phase 6: Add-to-list overflow chain hardening and nested list admin model

**Goal:** Expose overflow chains as one root-managed logical list so admin discovery, detail, delete, and reorder flows stay root-only, chain-aware, and safe.
**Requirements**: [OFLOW-01, OFLOW-02, OFLOW-03, OFLOW-04, OFLOW-05, OFLOW-06]
**Depends on:** Phase 5
**Success Criteria** (what must be TRUE):
  1. Overflow pages are never selectable/discoverable in uploader or admin list-selection flows; only root lists appear there.
  2. Admin list discovery shows logical totals for the whole overflow chain and can indicate when root lists have overflow pages.
  3. Direct navigation to an overflow list routes admins back to the root detail page, which shows one aggregated sermon list plus page-boundary/chain diagnostics.
  4. Inconsistent chains stay readable but clearly warn admins and disable risky actions such as reorder or destructive operations.
  5. Root-list delete is blocked when overflow pages exist and explains the affected chain instead of silently cascading.
  6. Root edits keep overflow names canonical and root-detail reorder remaps page boundaries for the full logical chain.
**Plans:** 7 plans

Plans:
- [ ] 06-01-PLAN.md — Define explicit root/overflow metadata and add the shared chain-audit callable
- [ ] 06-02-PLAN.md — Persist canonical chain metadata, logical totals, and rename behavior on list write paths
- [ ] 06-03-PLAN.md — Convert discovery/search/selection flows to a migration-safe root-only admin model
- [ ] 06-04-PLAN.md — Make the root detail page the single aggregated chain-management entry point
- [ ] 06-05-PLAN.md — Upgrade reorder to remap the full logical chain safely from the root detail page (worktree + summary complete; commits/emulator verification blocked)
- [ ] 06-06-PLAN.md — Add a dry-run-safe legacy backfill/repair script for explicit overflow metadata
- [ ] 06-07-PLAN.md — Add chain-aware delete blocking and cascade-warning admin UX

Worktree note:
- Plans `06-03`, `06-04`, and `06-07` have implementation changes and summaries on disk, but they remain incomplete in roadmap progress because `.git/index.lock` writes are denied in this environment.
