---
status: complete
phase: 05-speaker-management-crud-admin-create-speaker-popup-with-optional-speaker-list-association
source:
  - 05-01-SUMMARY.md
  - 05-02-SUMMARY.md
started: 2026-03-13T04:57:27Z
updated: 2026-03-13T07:05:00Z
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

complete: true
result: verification complete
note: |
  UAT finished for phase 05. All tests passed after follow-up fixes for speaker list image sync and dedicated speaker details management.

## Tests

### 1. Admin Speakers Create CTA and Popup
expected: On /admin/speakers, an admin sees a top-level Add Speaker button. Clicking it opens a popup with fields for speaker name, optional short description, optional description, image selection, and optional speaker-list creation.
result: pass

### 2. Speaker Create Validation
expected: The create popup requires a square image before submit, shows clear validation feedback, and does not require a manual sermon count field.
result: pass

### 3. Direct Speaker Create
expected: Creating a speaker directly from the popup succeeds without the old sermon publish workaround, creates the speaker in the table, and shows the selected images on the created speaker.
result: pass

### 4. Optional Speaker List Success Flow
expected: When speaker-list creation is selected, speaker creation succeeds and the success popup shows the exact Subsplash link and instruction text for placing the new list under the speakers list.
result: pass

### 5. Speaker Details Tag Link
expected: Opening speaker details for a speaker with a tag shows a Subsplash Tag link under the images on the left, and the link opens the expected Subsplash speaker tag page.
result: pass

### 6. Delete Speaker Confirmation
expected: Speaker details includes a Delete Speaker action. Clicking it opens a confirmation popup explaining the destructive effects before deletion occurs.
result: pass

### 7. Delete Speaker Cleanup
expected: Deleting a speaker removes the Firestore speaker record, deletes the Subsplash speaker tag, deletes any associated speaker list, and removes that speaker from sermon speaker arrays without deleting the sermons themselves.
result: pass

### 8. Admin-only Speaker Create/Delete
expected: Only admins can create or delete speakers. Publishers should be blocked from create/delete even though update remains available.
result: pass

## Summary

total: 8
passed: 8
issues: 0
pending: 0
skipped: 0
