---
phase: 04-role-based-invite-onboarding-and-operational-notification-routing
plan: 04
subsystem: ui
tags: [firebase-functions, invite-onboarding, admin-users, role-requests, nextjs]
requires:
  - phase: 04-02
    provides: Role-request callable contract and persistence behavior
  - phase: 04-03
    provides: Invite issuance and claim callable contracts
provides:
  - Lower-case callable exports for invite and role-request v2 URLs
  - Admin invite generation UI with claim-link output and copy flow
  - Functional role-request submit form with success/error feedback
  - Invite claim and success routes with auth callback continuity
affects: [admin-users-ui, invite-claim-routing, login-callback-routing]
tech-stack:
  added: []
  patterns:
    - Lower-case callable export names to match createFunctionV2 URL routing
    - Encoded callback path handoff through login for deep-link resume
key-files:
  created:
    - pages/invite/claim.tsx
    - pages/invite/success.tsx
    - .planning/phases/04-role-based-invite-onboarding-and-operational-notification-routing/deferred-items.md
  modified:
    - functions/src/index.ts
    - pages/admin/users.tsx
    - components/UserTable.tsx
    - components/RequestUploadPrivalige.tsx
    - components/Login.tsx
key-decisions:
  - "Exported createrolerequest/createinvite/claiminvite with lower-case keys for v2 callable URL compatibility."
  - "Used an admin invite dialog anchored in the users toolbar to keep existing table sorting and pagination untouched."
  - "Normalized login callback parsing to accept callbackurl and callbackUrl with open-redirect-safe local-path enforcement."
patterns-established:
  - "Invite claim flow: unauthenticated users redirect to /login with encoded callback path and resume post-auth."
  - "Role-request and invite actions surface callable success/error directly in existing UI feedback patterns."
requirements-completed: [INVITE-03, ROLE-REQ-01]
duration: 7 min
completed: 2026-03-01
---

# Phase 04 Plan 04: UI Wiring for Invite and Role-Request Flows Summary

**Admin invite issuance, role-request submission, and invite claim onboarding are now reachable end-to-end through existing UI routes and login callback continuity.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-01T09:11:41Z
- **Completed:** 2026-03-01T09:18:44Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Exported invite and role-request callables from functions index using lower-case route-compatible names.
- Replaced disabled role-request placeholder behavior with a live callable submit flow and feedback states.
- Added admin invite generation UX with email/role inputs and generated claim-link surfacing.
- Implemented `/invite/claim` and `/invite/success` routes, including login redirect resume and token refresh after claim.
- Extended login callback parsing to support both `callbackurl` and `callbackUrl`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Export new role-request and invite callables** - `33c2c685` (feat)
2. **Task 2: Implement admin invite issuance UI and functional role-request submit flow** - `7f5770e4` (feat)
3. **Task 3: Implement invite claim and success routes with login callback continuity** - `060a2c2d` (feat)

## Files Created/Modified
- `functions/src/index.ts` - Added lower-case callable exports for `createrolerequest`, `createinvite`, and `claiminvite`.
- `components/RequestUploadPrivalige.tsx` - Replaced disabled placeholder with working `createrolerequest` submit + feedback states.
- `components/UserTable.tsx` - Added toolbar action slot for admin invite trigger without changing table behavior.
- `pages/admin/users.tsx` - Added invite creation dialog and invite-link output/copy flow.
- `components/Login.tsx` - Added callback alias parsing for both `callbackurl` and `callbackUrl`.
- `pages/invite/claim.tsx` - Added invite-claim route with auth redirect resume and claim callable execution.
- `pages/invite/success.tsx` - Added dedicated post-claim success destination.
- `.planning/phases/04-role-based-invite-onboarding-and-operational-notification-routing/deferred-items.md` - Logged out-of-scope baseline TypeScript failures.

## Decisions Made
- Callable exports were aligned to lower-case keys so `createFunctionV2('...')` routes resolve consistently in local and deployed environments.
- Invite issuance was implemented as a dialog from the existing users table toolbar to avoid altering role dropdown, pagination, and sorting behavior.
- Login callback parsing now accepts both camel and lowercase query aliases while rejecting absolute URLs to avoid open redirects.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected executor tooling path for state commands**
- **Found during:** Plan initialization
- **Issue:** `~/.claude/get-shit-done/bin/gsd-tools.cjs` was unavailable in this workspace.
- **Fix:** Used the provided workspace toolchain path at `~/.codex/get-shit-done/bin/gsd-tools.cjs`.
- **Files modified:** None
- **Verification:** `init execute-phase` succeeded and returned phase metadata.
- **Committed in:** N/A (execution environment adjustment only)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope expansion; deviation only corrected execution tooling path.

## Issues Encountered
- `pnpm exec tsc --noEmit` (Task 3 verification command) fails on pre-existing unrelated type errors in non-plan files. These were logged to `deferred-items.md` and left out of scope per phase boundary rules.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Plan `04-04` deliverables are complete and integrated with previously shipped backend callables.
- Phase 04 now has summaries for all plans and is ready for phase transition/verification workflows.

## Self-Check: PASSED

---
*Phase: 04-role-based-invite-onboarding-and-operational-notification-routing*
*Completed: 2026-03-01*
