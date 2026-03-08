---
phase: quick-2-immediately-redirect-to-admin-sermons-after-delete
plan: 2
subsystem: ui
tags: [nextjs, mui, router, firestore, cloud-functions, admin-sermons]
requires:
  - phase: quick-1-prevent-sermon-counter-overwrites
    provides: sermon details page safety guards used by current quick flow
provides:
  - shared sermon delete helper with best-effort external cleanup
  - immediate details-page redirect to admin sermons carrying delete intent payload
  - one-shot admin-sermons delete executor with progress/success/error toast lifecycle
affects: [admin-sermons, sermon-details, delete-workflow, toast-feedback]
tech-stack:
  added: []
  patterns:
    - pass destructive-action intent via router query and execute in destination page effect
    - keep external cleanup best-effort and preserve Firestore delete as canonical source of truth
key-files:
  created: [utils/deleteSermonWithExternalCleanup.ts]
  modified: [pages/admin/sermons/[sermonId].tsx, pages/admin/sermons.tsx]
key-decisions:
  - "Delete execution moved to /admin/sermons so details page can redirect immediately after confirmation."
  - "Delete intent payload is cleared from URL after execution to prevent replay on rerender/back/refresh."
patterns-established:
  - "Immediate Redirect + Destination Execution: start destructive flow with route intent, execute once after navigation."
requirements-completed: [adhoc-sermon-delete-immediate-admin-redirect, adhoc-sermon-delete-toast-lifecycle]
duration: 2min
completed: 2026-03-01
---

# Phase Quick 2 Plan 2: Immediate Redirect to Admin Sermons Summary

**Immediate sermon delete UX now redirects from details to `/admin/sermons` instantly and completes deletion there with progress-to-result toast feedback.**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-01T07:04:23Z
- **Completed:** 2026-03-01T07:07:20Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Centralized sermon deletion orchestration in a reusable helper that keeps external cleanups best-effort and always attempts Firestore delete.
- Changed details-page delete confirmation to navigate immediately with delete intent payload instead of blocking on external cleanup.
- Added destination-page delete execution with MUI `Snackbar` + `Alert` lifecycle: progress, success, and error.

## Task Commits

1. **Task 1: Extract reusable sermon delete workflow helper** - `2e9db0e` (feat)
2. **Task 2: Redirect immediately from details page with delete intent payload** - `9918da0` (feat)
3. **Task 3: Run delete in admin sermons page and show progress/success/error toasts** - `d58a190` (feat)

## Files Created/Modified

- `utils/deleteSermonWithExternalCleanup.ts` - Shared delete orchestration wrapper for Subsplash/SoundCloud cleanup and Firestore sermon deletion.
- `pages/admin/sermons/[sermonId].tsx` - Delete-confirm action now redirects immediately to `/admin/sermons` with delete intent payload.
- `pages/admin/sermons.tsx` - One-shot delete intent effect with progress/success/error toast state and payload clearing.

## Decisions Made

- Execute deletion in destination view (`/admin/sermons`) to eliminate perceived latency on the details page.
- Use route query payload as lightweight delete intent contract for continuation after navigation.
- Keep failure visibility in destination-page toasts instead of blocking navigation with details-page alerts.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Minor helper export/signature mismatch with verification grep expectation; corrected to `export async function` before Task 1 commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Delete UX now aligns with immediate-navigation expectation and observable completion status.
- Ready for browser UAT of the redirect + toast lifecycle flow.

## Self-Check: PASSED

- Found summary file: `.planning/quick/2-immediately-redirect-to-admin-sermons-af/2-SUMMARY.md`
- Found task commits: `2e9db0e`, `9918da0`, `d58a190`
