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

### Subsplash Alpha-Lock Concurrency Control (Current Milestone)

- [x] **LOCK-01**: Lock acquisition is enforced before remote mutation reads/writes using deterministic lock-key sequencing per resource scope.
- [x] **LOCK-02**: Lock contention failures return bounded, structured payloads including `code`, `locked_keys`, `wait_ms`, and `retry_after_ms`.
- [x] **LOCK-03**: Callable mutation idempotency uses operation-key semantics so duplicate retry intents replay safely without duplicate side effects.
- [x] **LOCK-04**: Lock release executes in finally-path semantics and records dead-letter diagnostics when release attempts fail.
- [x] **LOCK-05**: Caller surfaces propagate operation keys and lock-busy retry guidance without swallowing external cleanup contention/failure details.

### Invite Onboarding + Operational Notifications (Current Milestone)

- [x] **INVITE-01**: Admins can issue role-targeted invite links that are single-use, email-bound, and expire after 30 days.
- [x] **INVITE-02**: Invite claims assign roles immediately for matching authenticated users while preventing implicit role downgrades.
- [x] **INVITE-03**: Successful invite claims redirect users to a dedicated invite success route.
- [x] **ROLE-REQ-01**: Role requests persist requester identity, requested role, timestamp, and admin-linkable metadata.
- [x] **ROLE-REQ-02**: New role requests route notifications to environment-configurable recipients with required production defaults.
- [x] **OPS-ALERT-01**: Role-request notification failures emit operational alert signals without rolling back persisted requests.
- [x] **OPS-ALERT-02**: Runtime caught failures enqueue structured operational notifications for every occurrence (no dedupe suppression).

### Speaker Management CRUD + Optional Speaker List Association (Current Milestone)

- [x] **SPK-01**: Admin speaker management is available through backend callable commands that support create, update, and delete.
- [x] **SPK-02**: `/admin/speakers` shows a top-level Add Speaker button.
- [x] **SPK-03**: Clicking Add Speaker opens a popup with complete speaker info inputs and image selection.
- [x] **SPK-04**: Popup submit supports optional speaker-list creation and speaker/list association in one flow.
- [x] **SPK-05**: Selected square images are reused for both speaker tag and speaker list payloads.
- [x] **SPK-06**: When speaker-list creation succeeds, UI shows the exact Subsplash link and exact required instruction copy.
- [x] **SPK-07**: Speaker create/update/delete flows are protected by regression coverage for auth, validation, and optional list side effects.

### Overflow Chain Hardening + Root-Only List Admin Model (Current Milestone)

- [ ] **OFLOW-01**: Overflow pages are never selectable or first-class discoverable records in uploader/admin list-selection flows; root lists are the only selectable/discoverable entities there.
- [ ] **OFLOW-02**: Admin list discovery shows root-level logical totals across the full overflow chain and can indicate when nested overflow pages exist.
- [ ] **OFLOW-03**: Direct navigation to an overflow list route redirects to the root list detail page, which is the single admin entry point for the logical list.
- [ ] **OFLOW-04**: The root detail page aggregates chain sermons into one view, shows page-boundary/chain diagnostics, and disables risky actions when the chain is inconsistent.
- [ ] **OFLOW-05**: Root-list delete is blocked when overflow pages exist and returns a clear cascade-aware explanation instead of silently cascading or succeeding.
- [ ] **OFLOW-06**: Root metadata edits and reorder operations preserve canonical overflow naming and remap Subsplash page boundaries for the whole logical list safely.

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
| LOCK-01 | Phase 3 | Complete |
| LOCK-02 | Phase 3 | Complete |
| LOCK-03 | Phase 3 | Complete |
| LOCK-04 | Phase 3 | Complete |
| LOCK-05 | Phase 3 | Complete |
| INVITE-01 | Phase 4 | Complete |
| INVITE-02 | Phase 4 | Complete |
| INVITE-03 | Phase 4 | Complete |
| ROLE-REQ-01 | Phase 4 | Complete |
| ROLE-REQ-02 | Phase 4 | Complete |
| OPS-ALERT-01 | Phase 4 | Complete |
| OPS-ALERT-02 | Phase 4 | Complete |
| SPK-01 | Phase 5 | Complete |
| SPK-02 | Phase 5 | Complete |
| SPK-03 | Phase 5 | Complete |
| SPK-04 | Phase 5 | Complete |
| SPK-05 | Phase 5 | Complete |
| SPK-06 | Phase 5 | Complete |
| SPK-07 | Phase 5 | Complete |
| OFLOW-01 | Phase 6 | Planned |
| OFLOW-02 | Phase 6 | Planned |
| OFLOW-03 | Phase 6 | Planned |
| OFLOW-04 | Phase 6 | Planned |
| OFLOW-05 | Phase 6 | Planned |
| OFLOW-06 | Phase 6 | Planned |
| SEC-01 | Next milestone candidate | Pending |
| SEC-02 | Next milestone candidate | Pending |
| REL-01 | Next milestone candidate | Pending |
| REL-02 | Next milestone candidate | Pending |
| ARCH-01 | Next milestone candidate | Pending |
| TEST-01 | Next milestone candidate | Pending |

**Coverage:**
- v1 requirements: 39 total
- Mapped to active phases or baseline: 39
- Unmapped: 0

---
*Requirements defined: 2026-02-28*
*Last updated: 2026-03-08 after phase 03-07 completion*
