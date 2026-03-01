---
status: diagnosed
trigger: "Investigate inconsistent sermon counters in Firestore that show impossible states like numberOfListsUploadedTo/numberOfLists = 4/1 in production."
created: 2026-03-01T06:22:03Z
updated: 2026-03-01T06:25:24Z
---

## Current Focus

hypothesis: Counter drift has multiple causes: a confirmed historical delete-path bug plus current non-idempotent increment listeners.
test: Synthesize evidence into ranked root causes and drift timelines.
expecting: historical bug explains existing bad data; idempotency gap explains ongoing risk.
next_action: return diagnosis with remediation tradeoffs (listener hardening vs aggregate queries)

## Symptoms

expected: numberOfListsUploadedTo should always be between 0 and numberOfLists.
actual: prod has records like 4/1.
errors: no explicit runtime error provided.
reproduction: unknown; observed in production UI status badge/progress.
started: issue seen in prod recently; codebase includes fixes around sermonListOnDelete in Jan 2026.

## Eliminated

- hypothesis: UI is computing the 4/1 badge from local list rows incorrectly
  evidence: `SermonListCard` reads persisted sermon counters directly, while `ManagePublishingPopup` computes counts from subcollection; mismatch indicates backend counter drift, not rendering math error.
  timestamp: 2026-03-01T06:25:24Z

## Evidence

- timestamp: 2026-03-01T06:22:39Z
  checked: functions/src/DocumentListeners/SermonLists/sermonListOnCreate.ts
  found: on create only `numberOfLists` is incremented by +1 via transaction; `numberOfListsUploadedTo` is untouched.
  implication: uploaded counter depends entirely on update/delete listener paths.

- timestamp: 2026-03-01T06:22:39Z
  checked: functions/src/DocumentListeners/SermonLists/sermonListOnUpdate.ts
  found: uploaded counter changes are based on `before.uploadStatus.status` -> `after.uploadStatus.status` transitions using `FieldValue.increment(±1)`.
  implication: repeated delivery of the same update event is not deduplicated in code; increments are not idempotent.

- timestamp: 2026-03-01T06:22:39Z
  checked: functions/src/DocumentListeners/SermonLists/sermonListOnDelete.ts
  found: delete listener always decrements `numberOfLists` by -1 and conditionally decrements uploaded by -1 when deleted doc status is `UPLOADED`, regardless of Subsplash API success.
  implication: current delete behavior attempts to keep counters aligned with Firestore subcollection state even on external API failures.

- timestamp: 2026-03-01T06:22:39Z
  checked: components/SermonListCard.tsx and components/ManagePublishingPopup.tsx
  found: card badge displays stored sermon counters (`numberOfListsUploadedTo/numberOfLists`), but popup computes counts directly from live `sermonLists` subcollection.
  implication: UI can surface impossible stored counters even when subcollection truth is correct.

- timestamp: 2026-03-01T06:22:39Z
  checked: functions/src/utils/recalculateSermonCounts.ts and functions/src/fixSermonCounts.ts
  found: a recalculation/repair callable exists and is exported, but no code path invokes it automatically.
  implication: drift persists until manual repair runs.

- timestamp: 2026-03-01T06:25:24Z
  checked: git show 2e9a0bc / 481c721 / f15cb44 on sermonListOnDelete.ts
  found: from `2e9a0bc` through `481c721`, decrement of `numberOfListsUploadedTo` was gated by `removeFromSubsplashSuccess`; `f15cb44` changed this with explicit comment "CRITICAL FIX" to decrement based on uploadStatus regardless of Subsplash removal success.
  implication: historical deletes of uploaded lists could decrement total without decrementing uploaded, directly producing uploaded>total drift.

- timestamp: 2026-03-01T06:25:24Z
  checked: git show 958a329 and 2e9a0bc on create/update/delete listeners
  found: original implementations did not `await` sermon counter updates; 2e9a0bc introduced awaits/transactions to address race conditions.
  implication: pre-Jun-2025 listener executions could lose or race counter writes, leaving legacy drift in long-lived docs.

- timestamp: 2026-03-01T06:25:24Z
  checked: functions/src/DocumentListeners/Lists/listItemOnDelete.ts and admin publish flows
  found: list membership changes delete/create `sermons/{sermonId}/sermonLists/{listId}` docs, which trigger sermon counter listeners; no invariant check clamps or recomputes after listener updates.
  implication: listener drift compounds over time without automatic correction.

## Resolution

root_cause: |
  1) Confirmed historical bug (high confidence): from Jun 4, 2025 (2e9a0bc) until Jan 3, 2026 (f15cb44), sermonListOnDelete decremented uploaded count only when Subsplash removal succeeded. Any uploaded-list delete with Subsplash failure/404 reduced `numberOfLists` but not `numberOfListsUploadedTo`.
  2) Ongoing design gap (medium-high confidence): current listener updates are non-idempotent FieldValue increments with no event dedupe/reconciliation. Duplicate or replayed update/delete events can still over/under-count.
  3) Legacy contributor (medium confidence): original 2023-2025 listeners did async writes without await, allowing dropped/racy increments before the 2e9a0bc hardening.
fix:
verification: root-cause diagnosis only (no code changes applied)
files_changed: []
