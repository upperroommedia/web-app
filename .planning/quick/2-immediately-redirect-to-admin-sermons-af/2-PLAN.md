---
phase: quick-2-immediately-redirect-to-admin-sermons-after-delete
plan: 2
type: execute
wave: 1
depends_on: []
files_modified:
  - pages/admin/sermons/[sermonId].tsx
  - pages/admin/sermons.tsx
  - utils/deleteSermonWithExternalCleanup.ts
autonomous: true
requirements:
  - adhoc-sermon-delete-immediate-admin-redirect
  - adhoc-sermon-delete-toast-lifecycle
user_setup: []
must_haves:
  truths:
    - "After confirming delete from a sermon details page, the UI navigates to `/admin/sermons` immediately instead of waiting on external cleanup calls."
    - "Admins/uploaders see a delete progress toast, then a success or error toast tied to the same delete attempt."
    - "Delete failure is surfaced as a toast on `/admin/sermons` without blocking navigation."
  artifacts:
    - path: "utils/deleteSermonWithExternalCleanup.ts"
      provides: "Reusable async delete workflow (Subsplash/SoundCloud best-effort cleanup + Firestore sermon delete)."
      exports: ["deleteSermonWithExternalCleanup"]
    - path: "pages/admin/sermons/[sermonId].tsx"
      provides: "Delete confirm action that redirects immediately to admin sermons with delete payload."
    - path: "pages/admin/sermons.tsx"
      provides: "Toast lifecycle host for delete progress/success/error and single-run delete execution."
  key_links:
    - from: "pages/admin/sermons/[sermonId].tsx"
      to: "pages/admin/sermons.tsx"
      via: "router navigation payload for delete intent"
      pattern: "router\\.(push|replace)\\('/admin/sermons'"
    - from: "pages/admin/sermons.tsx"
      to: "utils/deleteSermonWithExternalCleanup.ts"
      via: "delete orchestration effect"
      pattern: "deleteSermonWithExternalCleanup"
    - from: "pages/admin/sermons.tsx"
      to: "MUI Snackbar/Alert"
      via: "progress->success/error toast state transitions"
      pattern: "Snackbar|Alert"
---

<objective>
Deliver an immediate post-confirmation redirect from sermon details to admin sermons while keeping delete feedback visible through toast states (progress, success, error).

Purpose: Remove perceived delete lag on the details page and make delete outcomes visible in the destination view.
Output: Shared delete helper + redirect payload wiring + `/admin/sermons` toast lifecycle handling.
</objective>

<execution_context>
@/Users/yasaad/.codex/get-shit-done/workflows/execute-plan.md
@/Users/yasaad/.codex/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@pages/admin/sermons/[sermonId].tsx
@pages/admin/sermons.tsx
@components/DeleteEntityPopup.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: Extract reusable sermon delete workflow helper</name>
  <files>utils/deleteSermonWithExternalCleanup.ts, pages/admin/sermons/[sermonId].tsx</files>
  <action>
    Create a reusable helper that encapsulates the current delete behavior so both pages can use one canonical flow:

    - Add `deleteSermonWithExternalCleanup` in `utils/deleteSermonWithExternalCleanup.ts`.
    - Input contract should include `sermonId` and optional `subsplashId` + `soundCloudTrackId`.
    - Keep external cleanups best-effort (`Promise.allSettled`) and always attempt Firestore sermon delete.
    - Normalize thrown errors to `Error` with user-safe message text for toast display.
    - Update the details page to call this helper instead of inline delete logic.

    Guardrails:
    - Do not change who is allowed to delete.
    - Do not block Firestore delete when external cleanup calls fail.
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit && rg -n "export (async )?function deleteSermonWithExternalCleanup" utils/deleteSermonWithExternalCleanup.ts</automated>
  </verify>
  <done>
    Deletion logic is centralized in one helper and the details page no longer duplicates external cleanup + Firestore delete orchestration.
  </done>
</task>

<task type="auto">
  <name>Task 2: Redirect immediately from details page with delete intent payload</name>
  <files>pages/admin/sermons/[sermonId].tsx</files>
  <action>
    Change the delete confirmation flow so the user leaves the details page immediately after confirmation:

    - On confirmed delete, navigate to `/admin/sermons` immediately with a delete-intent payload (query params or equivalent lightweight route state) containing sermon id and external ids needed by the helper.
    - Stop waiting on delete completion before route transition.
    - Keep delete button/popup behavior safe against double-submit while navigation is in progress.
    - Preserve existing current-sermon player cleanup behavior (`setCurrentSermon(undefined)` when applicable).

    Guardrails:
    - Do not reintroduce blocking `await` on external cleanup before navigation.
    - Keep destructive action behind the existing confirmation popup.
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit && rg -n "admin/sermons" pages/admin/sermons/\\[sermonId\\].tsx && rg -n "deleteSermonWithExternalCleanup|delete intent|isDeleting" pages/admin/sermons/\\[sermonId\\].tsx</automated>
  </verify>
  <done>
    Confirmed delete from details routes to `/admin/sermons` immediately and carries enough context for deletion to continue in the destination view.
  </done>
</task>

<task type="auto">
  <name>Task 3: Run delete in admin sermons page and show progress/success/error toasts</name>
  <files>pages/admin/sermons.tsx, utils/deleteSermonWithExternalCleanup.ts</files>
  <action>
    Implement destination-page delete execution and toast lifecycle:

    - Add a one-shot effect in `pages/admin/sermons.tsx` that detects delete-intent payload on mount/navigation.
    - Immediately show progress toast/snackbar (e.g. "Deleting sermon...").
    - Execute `deleteSermonWithExternalCleanup` from this page.
    - On success, show success toast and clear delete-intent payload so refresh/back does not re-run delete.
    - On failure, show error toast (including helper message) and clear payload to avoid infinite retry loops.
    - Use MUI `Snackbar` + `Alert` pattern consistent with existing app usage (see admin users page).

    Guardrails:
    - Ensure delete attempt runs once per payload (no duplicate execution from rerenders).
    - Keep existing Admin Sermons list rendering unchanged outside this flow.
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit && rg -n "Snackbar|Alert|Deleting sermon|deleteSermonWithExternalCleanup" pages/admin/sermons.tsx</automated>
  </verify>
  <done>
    Admin Sermons page shows progress/success/error toasts for delete workflow and does not replay the same delete on reload/back navigation.
  </done>
</task>

</tasks>

<verification>
- `pnpm exec tsc --noEmit` passes.
- Confirm with browser flow: open `/admin/sermons/{id}`, click delete, confirm immediate redirect to `/admin/sermons`, then verify progress toast transitions to success or error.
</verification>

<success_criteria>
- Delete confirmation no longer keeps user on sermon details while waiting on external cleanup.
- Delete outcome is communicated with toast states: progress, success, and error.
- Delete execution is single-run and resilient to rerenders/navigation.
</success_criteria>

<output>
After completion, create `.planning/quick/2-immediately-redirect-to-admin-sermons-af/2-SUMMARY.md`
</output>
