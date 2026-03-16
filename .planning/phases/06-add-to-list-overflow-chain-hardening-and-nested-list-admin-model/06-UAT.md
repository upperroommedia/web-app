---
status: testing
phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model
source:
  - 06-01-SUMMARY.md
  - 06-02-SUMMARY.md
  - 06-03-SUMMARY.md
  - 06-04-SUMMARY.md
  - 06-05-SUMMARY.md
  - 06-06-SUMMARY.md
  - 06-07-SUMMARY.md
started: 2026-03-14T21:45:58Z
updated: 2026-03-14T11:17:00-07:00
---

## Current Test

number: 5
name: Root-Aware Reorder
expected: |
  Reordering from the root list detail page should save one logical order across the full chain rather than only the first page.
  If the chain is unhealthy or mirror coverage is incomplete, save-order should stay disabled and not attempt the reorder mutation.
awaiting: user response

## Tests

### 1. Root-Only Uploader List Selection
expected: In uploader flows that let you pick lists, only the main root list should appear as a selectable option. Overflow or nested continuation pages should not appear as separate selectable lists, even when searching.
result: pass

### 2. Root-Only Admin List Discovery
expected: On `/admin/lists`, each logical list should appear once as the root row. Overflow pages should not show up as separate discoverable rows, and the root row should show the logical total plus an overflow indicator when the chain has nested pages.
result: pass

### 3. Overflow Route Redirect And Diagnostics
expected: Opening an overflow list detail route directly should redirect to the root list detail page. The root page should show a chain diagnostics panel with overflow page names, ids, and ordering/depth information instead of treating overflow pages as standalone editable list pages.
result: pass

### 4. Root Detail Aggregated List View
expected: The root list detail page should show one aggregated mirrored sermon list across the chain with subtle page-boundary markers. If chain metadata or mirrored rows are inconsistent, the page should stay readable but show a warning and disable risky actions.
result: issue
reported: "yes this is working but I do in fact want to be able to reorder and remove sermons from the list from the details page similar to the series page. Also can you put the overflow chain on the right hand side and make it a bit smaller"
severity: major

### 5. Root-Aware Reorder
expected: Reordering from the root list detail page should save one logical order across the full chain rather than only the first page. If the chain is unhealthy or mirror coverage is incomplete, save-order should stay disabled and not attempt the reorder mutation.
result: pending

### 6. Delete Guard For Overflow Chains
expected: Trying to delete a root list that still has overflow pages should stay blocked in the admin UI. The confirmation flow should remain open and explain that overflow pages must be resolved first instead of acting like the delete succeeded.
result: pending

### 7. Backfill Tool Dry-Run Visibility
expected: Running the documented overflow metadata backfill in dry-run mode should report what would be repaired, skip inconsistent chains, and avoid mutating list records until apply mode is used.
result: pending

## Summary

total: 7
passed: 0
passed: 3
issues: 1
pending: 3
skipped: 0

## Gaps

- truth: "The root list detail page should show one aggregated mirrored sermon list across the chain with subtle page-boundary markers. If chain metadata or mirrored rows are inconsistent, the page should stay readable but show a warning and disable risky actions."
  status: failed
  reason: "User reported: yes this is working but I do in fact want to be able to reorder and remove sermons from the list from the details page similar to the series page. Also can you put the overflow chain on the right hand side and make it a bit smaller"
  severity: major
  test: 4
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""
