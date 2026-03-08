# Phase 3: Subsplash alpha-lock concurrency control - Context

**Gathered:** 2026-03-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Introduce a lock-based concurrency safety layer for all mutation paths that touch Subsplash-linked entities so stale reads cannot overwrite newer writes. This phase covers lock acquisition/wait/release/idempotency behavior for series/list/sermon mutations and their callables. It does not add new product-facing publishing features.

</domain>

<decisions>
## Implementation Decisions

### Lock Scope and Ownership
- Locking is entity-based across mutation paths:
  - series lock for series mutations
  - list lock for list mutations
  - sermon/media-item lock for sermon/media-item mutations
- Any mutation path must acquire the relevant lock(s) before making writes.
- If multiple locks are required, acquire them using a global deterministic ordering rule (entity type order, then entity ID order).
- Lock acquisition/release is owned by Cloud Functions only (clients do not manage locks).
- Any read used to decide writes must happen only after lock acquisition (read-after-lock always).

### Wait/Timeout and Contention Contract
- On lock contention, operations wait with bounded timeout (not fail-fast by default).
- Initial lock wait timeout target: 10 seconds.
- Retry policy is caller-controlled: function returns a structured busy response and caller decides retry behavior.
- Standard contention error payload should include:
  - machine-readable busy code
  - locked entity key(s)
  - wait_ms attempted
  - retry_after_ms hint

### Recovery, Stale Locks, and Idempotency
- Use TTL + heartbeat for stale lock reclamation.
- Lock state store: Realtime Database (RTDB).
- Mutation endpoints use per-operation idempotency keys so retries do not duplicate side effects.
- Enforce hard release guarantees (finally-block release paths) plus dead-letter/error logging for orphaned release failures.

### Claude's Discretion
- Exact TTL and heartbeat intervals.
- Exact retry-after calculation strategy.
- Lock record schema details in RTDB.
- Dead-letter sink implementation details (logging channel/collection/topic).

</decisions>

<specifics>
## Specific Ideas

- "Any API call that touches a specific item must retrieve lock, then call, then release lock."
- "All reads about state of world must occur after lock retrieval so stale data cannot overwrite other operations."
- Lock abstraction should be reusable beyond series operations (lists and sermons too).

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `functions/src/addToSeries.ts`, `removeFromSeries.ts`, `reorderSeriesItems.ts`: current high-risk series mutation callables.
- `functions/src/uploadToSubsplash.ts`, `addToList.ts`, `removeFromList.ts`: additional mutation surfaces that need consistent lock behavior.
- `functions/src/helpers/seriesHelpers.ts`: existing Subsplash patch/read helpers where lock-guarded sequencing can be centralized.
- `utils/createFunction.ts`: typed callable wrapper pattern used by UI callers.

### Established Patterns
- Frontend uses callable functions with typed `createFunctionV2` wrappers and expects actionable error messaging.
- Firestore `series/{id}/seriesItems` is used as app-side ordering/state source; Subsplash reorder is applied with inverted semantics (`position 1` is bottom).
- Existing flows already do partial rollback on series publish/reorder failures, so lock layer should preserve/strengthen this behavior.

### Integration Points
- Backend: introduce shared lock utility used by all lock-required callables before external Subsplash mutations and dependent reads.
- Frontend/admin flows impacted by lock contention responses:
  - `components/ManagePublishingPopup.tsx`
  - `pages/admin/series/[seriesId].tsx`
  - `pages/admin/sermons/[sermonId].tsx`
- API helper modules that also create/update series items should align with lock-protected mutation contract:
  - `pages/api/uploadFile.tsx`
  - `pages/api/editSermon.ts`

</code_context>

<deferred>
## Deferred Ideas

- None — discussion stayed within phase scope.

</deferred>

---

*Phase: 03-subsplash-alpha-lock-concurrency-control*
*Context gathered: 2026-03-01*
