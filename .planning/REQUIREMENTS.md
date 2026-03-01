# Requirements: Upper Room Media Web App

**Defined:** 2026-02-28
**Core Value:** The platform provides a trustworthy end-to-end publishing pipeline for admins.

## v1 Requirements

### Platform Baseline (Validated)

- [x] **CORE-01**: Admin authentication and role capability checks gate privileged workflows.
- [x] **CORE-02**: Sermons, lists, and series domain models are persisted via typed Firestore converters.
- [x] **CORE-03**: Audio processing flow exists from upload to processed media output.
- [x] **CORE-04**: External publishing flows for Subsplash and SoundCloud are operational.
- [x] **CORE-05**: Search/discovery tooling is integrated for admin workflows.
- [x] **CORE-06**: Bundle generation and bundle consumption paths are active in the system.

### Publishing Reliability (Current Milestone)

- [x] **SERIES-01**: Series subtitle is always derived as `<publishedCount> part series` from explicit published series-item state.
- [x] **SERIES-02**: Publishing to series does not require prior list publishing state.
- [x] **SERIES-03**: Users retain a clear one-click combined publish flow while keeping independent actions.
- [x] **SERIES-04**: Legacy series-item publish flags can be reconciled without fallback semantics in runtime logic.

### Dev External API Safety (Current Milestone)

- [ ] **DEVSAFE-01**: Emulator runtime never sends outbound requests to production Subsplash or SoundCloud hosts.
- [ ] **DEVSAFE-02**: External API mode is fail-closed in emulator runs when policy is violated.
- [ ] **DEVSAFE-03**: Local admin publishing/testing flows remain usable through deterministic mocks.
- [ ] **DEVSAFE-04**: Regression checks block reintroduction of direct production endpoint usage in disallowed paths.

### Invite Onboarding + Operational Notifications (Current Milestone)

- [ ] **INVITE-01**: Admins can issue role-targeted invite links that are single-use, email-bound, and expire after 30 days.
- [ ] **INVITE-02**: Invite claims assign roles immediately for matching authenticated users while preventing implicit role downgrades.
- [ ] **INVITE-03**: Successful invite claims redirect users to a dedicated invite success route.
- [ ] **ROLE-REQ-01**: Role requests persist requester identity, requested role, timestamp, and admin-linkable metadata.
- [x] **ROLE-REQ-02**: New role requests route notifications to environment-configurable recipients with required production defaults.
- [ ] **OPS-ALERT-01**: Role-request notification failures emit operational alert signals without rolling back persisted requests.
- [x] **OPS-ALERT-02**: Runtime caught failures enqueue structured operational notifications for every occurrence (no dedupe suppression).

## v2 Requirements

### Platform Hardening and Simplification

- **SEC-01**: Callable/HTTP functions that mutate data require explicit auth + role checks with least-privilege defaults.
- **SEC-02**: Firestore/Storage/RTDB rules are tightened to reduce broad read/write surfaces.
- **REL-01**: Batch-write paths are corrected to avoid unawaited commits and silent partial writes.
- **REL-02**: High-fanout listener and bundle regeneration patterns are reduced to lower cost and timeout risk.
- **ARCH-01**: Large monolithic admin modules are decomposed to reduce regression risk and increase maintainability.
- **TEST-01**: Automated CI quality gates cover key backend auth/risk paths and core admin flows.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Framework migration to Next.js App Router | Not required to deliver current reliability/safety outcomes |
| Greenfield feature-family expansion before hardening | Current priority is stability, safety, and operational correctness |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CORE-01 | Pre-GSD baseline | Complete |
| CORE-02 | Pre-GSD baseline | Complete |
| CORE-03 | Pre-GSD baseline | Complete |
| CORE-04 | Pre-GSD baseline | Complete |
| CORE-05 | Pre-GSD baseline | Complete |
| CORE-06 | Pre-GSD baseline | Complete |
| SERIES-01 | Phase 1 | Complete |
| SERIES-02 | Phase 1 | Complete |
| SERIES-03 | Phase 1 | Complete |
| SERIES-04 | Phase 1 | Complete |
| DEVSAFE-01 | Phase 2 | In Progress |
| DEVSAFE-02 | Phase 2 | In Progress |
| DEVSAFE-03 | Phase 2 | In Progress |
| DEVSAFE-04 | Phase 2 | In Progress |
| INVITE-01 | Phase 4 | In Progress |
| INVITE-02 | Phase 4 | In Progress |
| INVITE-03 | Phase 4 | In Progress |
| ROLE-REQ-01 | Phase 4 | In Progress |
| ROLE-REQ-02 | Phase 4 | Complete |
| OPS-ALERT-01 | Phase 4 | In Progress |
| OPS-ALERT-02 | Phase 4 | Complete |
| SEC-01 | Next milestone candidate | Pending |
| SEC-02 | Next milestone candidate | Pending |
| REL-01 | Next milestone candidate | Pending |
| REL-02 | Next milestone candidate | Pending |
| ARCH-01 | Next milestone candidate | Pending |
| TEST-01 | Next milestone candidate | Pending |

**Coverage:**
- v1 requirements: 21 total
- Mapped to active phases or baseline: 21
- Unmapped: 0

---
*Requirements defined: 2026-02-28*
*Last updated: 2026-03-01 after phase 04-01 completion*
