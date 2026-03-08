---
phase: 04-role-based-invite-onboarding-and-operational-notification-routing
plan: 03
subsystem: auth
tags: [firebase-functions, firebase-auth, firestore-transactions, invites, emulator-tests]
requires:
  - phase: 04-01
    provides: notification/admin-base-url parameter baseline and callable response conventions
provides:
  - Admin invite issuance with hashed token persistence and 30-day expiry metadata
  - Authenticated invite claiming with strict email matching, single-use state transitions, and ROLE_FAILED retry handling
  - Emulator test coverage for invite issuance and claim lifecycle invariants
affects: [invite-onboarding, role-assignment, admin-users-ui]
tech-stack:
  added: []
  patterns:
    - Store only invite token hashes; return raw token only in generated claim URL
    - Resolve effective role via precedence map before setting merged auth custom claims
    - Transition invite claim state transactionally before role assignment side effects
key-files:
  created:
    - functions/src/invites/inviteTypes.ts
    - functions/src/invites/inviteToken.ts
    - functions/src/invites/createInvite.ts
    - functions/src/invites/claimInvite.ts
    - functions/src/test/invites/createInvite.test.ts
    - functions/src/test/invites/claimInvite.test.ts
  modified: []
key-decisions:
  - "Invite artifacts persist sha256 token hashes only; raw invite tokens are never stored."
  - "Claim flow uses Firestore transactions for consume-state validation, with ROLE_FAILED retry restricted to the original claimant."
  - "Role assignment merges existing custom claims and preserves higher existing roles via ROLE_PRECEDENCE."
patterns-established:
  - "Invite claims fail closed on unauthenticated calls, email mismatch, expiry, and consumed state."
  - "Successful claims always revoke refresh tokens after custom-claim updates."
requirements-completed: [INVITE-01, INVITE-02, INVITE-03]
duration: 4 min
completed: 2026-03-01
---

# Phase 4 Plan 3: Invite Backend Summary

**Role-targeted admin invite issuance and transactional invite claiming now enforce strict email match, single-use consumption, and no-downgrade role assignment with emulator regression coverage.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-01T09:04:44Z
- **Completed:** 2026-03-01T09:08:28Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Added invite domain contracts and token security primitives for role precedence, claim statuses, and hash-only token persistence.
- Implemented `createInvite` and `claimInvite` callables with admin/auth validation, transactional consume semantics, role-merge assignment, and refresh-token revocation.
- Added emulator tests validating admin-only issuance, token hashing, expiry/email/single-use guards, upgrade behavior, and no-downgrade role precedence.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define invite contracts, role precedence, and token helpers** - `d9c5668` (feat)
2. **Task 2: Implement createInvite and claimInvite callables with transactional consume semantics** - `a334e9c` (feat)
3. **Task 3: Add invite emulator tests for issue/claim correctness** - `5d5c34a` (test)

## Files Created/Modified

- `functions/src/invites/inviteTypes.ts` - Invite contracts, role precedence helpers, claim status constants, and input/output shapes.
- `functions/src/invites/inviteToken.ts` - Secure random token generation and sha256 hashing helpers.
- `functions/src/invites/createInvite.ts` - Admin-only invite issuance callable storing hashed token artifacts and returning claim URLs.
- `functions/src/invites/claimInvite.ts` - Authenticated transactional claim callable with no-downgrade role assignment and ROLE_FAILED fallback.
- `functions/src/test/invites/createInvite.test.ts` - Emulator tests for admin-only issuance, hashing guarantees, and invite metadata persistence.
- `functions/src/test/invites/claimInvite.test.ts` - Emulator tests for claim rejection paths, single-use behavior, role upgrade/no-downgrade, and token revocation call path.

## Decisions Made

- Keep callable responses in repository-standard `{ status: 'success' | 'error' }` format to remain consistent with existing function consumers.
- Allow retry only for `ROLE_FAILED` invites when the retrying claimant is the same uid/email that consumed the invite.
- Resolve final role with `ROLE_PRECEDENCE` to guarantee invite claims never downgrade an already-higher user role.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Execution helper path mismatch**
- **Found during:** Plan bootstrap
- **Issue:** Workflow instruction path `~/.claude/get-shit-done/bin/gsd-tools.cjs` is unavailable in this environment.
- **Fix:** Switched execution/state commands to `~/.codex/get-shit-done/bin/gsd-tools.cjs`.
- **Files modified:** None (execution environment only)
- **Verification:** `gsd-tools init execute-phase` and follow-up state commands succeeded using corrected path.
- **Committed in:** N/A (no repository file changes)

**2. [Rule 1 - Bug] Invite test URL parsing for relative claim URLs**
- **Found during:** Task 3 verification
- **Issue:** Initial tests parsed invite links with `new URL(url)` and failed when base URL resolved to a relative path in test runtime.
- **Fix:** Updated invite tests to parse with a base URL fallback (`new URL(url, 'https://example.test')`).
- **Files modified:** functions/src/test/invites/createInvite.test.ts, functions/src/test/invites/claimInvite.test.ts
- **Verification:** Plan test command passed under Firestore/Auth emulators.
- **Committed in:** `5d5c34a`

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes were required for successful execution and verification; no scope expansion.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Backend invite issuance and claim callables are ready for phase `04-04` UI wiring and callable export integration.
- Invite lifecycle invariants are locked by emulator tests and can be reused as regression gates in subsequent phases.

---
*Phase: 04-role-based-invite-onboarding-and-operational-notification-routing*
*Completed: 2026-03-01*

## Self-Check: PASSED

- FOUND: `.planning/phases/04-role-based-invite-onboarding-and-operational-notification-routing/04-03-SUMMARY.md`
- FOUND: `d9c5668`
- FOUND: `a334e9c`
- FOUND: `5d5c34a`
