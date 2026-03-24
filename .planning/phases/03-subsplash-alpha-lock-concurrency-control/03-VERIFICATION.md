---
phase: 03-subsplash-alpha-lock-concurrency-control
verified: 2026-03-08T00:42:33Z
status: passed
score: 5/5 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 2/5
  gaps_closed:
    - "Mutation callables acquire deterministic entity locks before any read that decides writes."
    - "Mutation retries are idempotent via per-operation keys and do not duplicate side-effects."
    - "Admin caller flows propagate operation keys and handle busy responses with explicit retry UX."
    - "Phase requirement IDs LOCK-01..LOCK-05 are fully traceable in REQUIREMENTS.md."
  gaps_remaining: []
  regressions: []
---

# Phase 03: Subsplash Alpha-Lock Concurrency Control Verification Report

**Phase Goal:** Enforce lock-based, idempotent concurrency safety for all Subsplash-linked series/list/sermon mutation callables so stale reads cannot overwrite newer writes.  
**Verified:** 2026-03-08T00:42:33Z  
**Status:** passed  
**Re-verification:** Yes - after gap closure

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Mutation callables acquire deterministic entity locks before any read-before-write decision. | ✓ VERIFIED | `bulkAddToSeries` now wraps flow in `withSubsplashLocks` and performs remote membership reads inside lock callback (`functions/src/bulkAddToSeries.ts:253-270`). Lock key ordering is deterministic by entity order + ID via `sortSubsplashLockKeys` (`functions/src/locks/lockTypes.ts:9-13`, `:61-72`) and enforced in wrapper (`functions/src/locks/withSubsplashLocks.ts:28`). |
| 2 | Lock contention waits up to 10 seconds then returns structured busy details (`code`, `locked_keys`, `wait_ms`, `retry_after_ms`). | ✓ VERIFIED | Timeout defaults remain `10_000` ms (`functions/src/locks/lockTypes.ts:3`) and contention throws `buildSubsplashLockBusyError` with structured details on timeout (`functions/src/locks/subsplashLockStore.ts:136-141`; `functions/src/locks/contentionError.ts:16-25`). |
| 3 | Mutation retries are idempotent via operation keys and avoid duplicate side-effects. | ✓ VERIFIED | `bulkAddToSeries` requires non-empty `operationKey` and wraps execution with `withIdempotency` (`functions/src/bulkAddToSeries.ts:70-73`, `:253`); external delete callable requires/uses `operationKey` with lock+idempotency (`functions/src/deleteFromSubsplash.ts:30-31`, `:46-59`). |
| 4 | Lock release is enforced in finally paths with dead-letter/error logging on release failures. | ✓ VERIFIED | `withSubsplashLocks` releases in `finally` and records failures via sink (`functions/src/locks/withSubsplashLocks.ts:63-77`); sink persists `lockReleaseFailures` docs (`functions/src/locks/releaseFailureSink.ts:46-65`). |
| 5 | Admin caller flows propagate operation keys and surface lock-busy retry guidance. | ✓ VERIFIED | Series delete now sends `operationKey` and parses lock-busy details (`pages/admin/series.tsx:52-59`, `:262-265`, `:272`); sermon external cleanup forwards operationKey and blocks local delete on external failure (`utils/deleteSermonWithExternalCleanup.ts:66-80`); sermons admin page renders retry guidance from busy details (`pages/admin/sermons.tsx:30-36`, `:137-141`). |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `functions/src/bulkAddToSeries.ts` | Lock + idempotency envelope for bulk mutation with stale snapshot guard | ✓ VERIFIED | `withIdempotency` + `withSubsplashLocks` wired; stale hash rejected before writes (`:253-279`). |
| `pages/admin/series.tsx` | Series delete caller sends operationKey and handles busy metadata | ✓ VERIFIED | `createOperationKey('series-admin-delete', ...)` and busy formatter wiring present (`:43-59`, `:262-265`, `:272`). |
| `utils/deleteSermonWithExternalCleanup.ts` | Propagate operationKey to `deletefromsubsplash`; do not swallow cleanup failure | ✓ VERIFIED | Sends `{ subsplashId, operationKey }` and only deletes local sermon after external cleanup resolves (`:66-80`). |
| `pages/admin/sermons.tsx` | Surface lock-busy retry guidance from cleanup utility | ✓ VERIFIED | Busy details parsed and shown in toast failure message (`:30-36`, `:137-141`). |
| `functions/src/locks/withSubsplashLocks.ts` | Deterministic lock orchestration + guaranteed finally release | ✓ VERIFIED | Ordered acquisition + release in reverse order with failure logging (`:28`, `:43-50`, `:66-77`). |
| `.planning/REQUIREMENTS.md` | Canonical LOCK-01..LOCK-05 definitions + Phase 3 traceability | ✓ VERIFIED | LOCK definitions and traceability rows present (`.planning/REQUIREMENTS.md:33-37`, `:85-89`). |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `functions/src/bulkAddToSeries.ts` | `functions/src/locks/withSubsplashLocks.ts` | series/media-item lock scope wrapper | WIRED | `withSubsplashLocks(lockKeys, ...)` with derived series+media keys (`bulkAddToSeries.ts:260-267`). |
| `functions/src/bulkAddToSeries.ts` | `functions/src/locks/withIdempotency.ts` | operation-key claim/complete/fail envelope | WIRED | `withIdempotency(normalizedOperationKey, ...)` (`bulkAddToSeries.ts:253`). |
| `pages/admin/series/[seriesId].tsx` | `bulkaddtoseries` callable | stable retry key + expected membership hash propagation | WIRED | `createRetryIntentKey(...)` then callable payload includes `operationKey` + `expectedPublishedMembershipHash` (`pages/admin/series/[seriesId].tsx:1176-1183`). |
| `pages/admin/series.tsx` | `deleteseries` callable | operationKey payload + busy retry messaging | WIRED | Callable includes generated key and lock-busy formatter path (`pages/admin/series.tsx:52-59`, `:262-265`, `:272`). |
| `utils/deleteSermonWithExternalCleanup.ts` | `deletefromsubsplash` callable | operationKey propagation + contention-aware failure propagation | WIRED | Deletes via callable with operationKey; catches and rethrows enriched error (`deleteSermonWithExternalCleanup.ts:69-70`, `:81-83`). |
| `pages/admin/sermons.tsx` | `utils/deleteSermonWithExternalCleanup.ts` | busy/error details surfaced as actionable retry guidance | WIRED | Cleanup call wrapped with toast UX using parsed busy details (`pages/admin/sermons.tsx:127-141`). |
| `functions/src/locks/withSubsplashLocks.ts` | `functions/src/locks/subsplashLockStore.ts` | acquire/wait/heartbeat/release lifecycle | WIRED | `acquireWithWait`, `startHeartbeat`, `releaseLock` invoked (`withSubsplashLocks.ts:44`, `:54`, `:69`). |
| `.planning/REQUIREMENTS.md` | Phase 03 plans | LOCK definitions + Phase 3 traceability | WIRED | LOCK-01..LOCK-05 appear in requirements section and traceability matrix (`REQUIREMENTS.md:33-37`, `:85-89`). |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| LOCK-01 | 03-01, 03-06, 03-07 | Lock acquisition is enforced before remote mutation reads/writes with deterministic lock-key sequencing. | ✓ SATISFIED | Deterministic sorting in lock substrate (`functions/src/locks/lockTypes.ts:61-72`) and bulk read-before-write inside lock callback (`functions/src/bulkAddToSeries.ts:265-270`). |
| LOCK-02 | 03-02, 03-03, 03-04, 03-06, 03-07 | Contention failures return structured busy payload with bounded wait metadata. | ✓ SATISFIED | 10s default timeout (`functions/src/locks/lockTypes.ts:3`) and structured `HttpsError.details` from lock timeout path (`functions/src/locks/subsplashLockStore.ts:136-141`, `functions/src/locks/contentionError.ts:16-25`). |
| LOCK-03 | 03-01, 03-02, 03-03, 03-04, 03-05, 03-06, 03-07 | Idempotency uses operation-key semantics for replay-safe retries. | ✓ SATISFIED | `withIdempotency` envelope in mutation callables (`functions/src/bulkAddToSeries.ts:253`, `functions/src/deleteFromSubsplash.ts:46`) and operationKey propagation in admin callers (`pages/admin/series.tsx:264`, `utils/deleteSermonWithExternalCleanup.ts:66-70`). |
| LOCK-04 | 03-01, 03-02, 03-03, 03-04, 03-05, 03-06, 03-07 | Lock release always executes in finally and dead-letters failures. | ✓ SATISFIED | Finally release loop + release failure sink (`functions/src/locks/withSubsplashLocks.ts:63-77`, `functions/src/locks/releaseFailureSink.ts:55-65`). |
| LOCK-05 | 03-01, 03-05, 03-06, 03-07 | Caller surfaces propagate operation keys and lock-busy retry guidance without masking cleanup contention/failures. | ✓ SATISFIED | Series and sermons admin surfaces parse/format busy details (`pages/admin/series.tsx:52-59`, `pages/admin/sermons.tsx:30-36`), cleanup utility preserves details/codes (`utils/deleteSermonWithExternalCleanup.ts:45-52`). |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `functions/src/deleteFromSubsplash.ts` | 41 | `console.log` in mutation callable | ℹ️ Info | Non-structured logging in production mutation path; does not block concurrency/idempotency guarantees. |
| `pages/api/uploadFile.tsx` | 107 | `TODO` in adjacent upload flow | ⚠️ Warning | Not part of lock substrate, but indicates remaining follow-up in publish-adjacent path. |

### Human Verification Required

No mandatory human-only checks are required to validate the phase contract.  
Optional smoke tests:
1. Run two concurrent admin sessions publishing to the same series and confirm one receives lock-busy retry guidance.
2. Trigger sermon delete contention and confirm retry messaging in `/admin/sermons` matches busy metadata.

### Gaps Summary

Previous blockers are closed:
- `bulkAddToSeries` now participates in deterministic lock + idempotency envelopes.
- Remaining admin delete entry points now propagate operation keys and preserve lock-busy guidance.
- `LOCK-01..LOCK-05` are now defined and traceable in `REQUIREMENTS.md`.

No goal-blocking gaps remain.

---

_Verified: 2026-03-08T00:42:33Z_  
_Verifier: Claude (gsd-verifier)_
