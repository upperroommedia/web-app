---
status: awaiting_human_verify
trigger: "Investigate issue: invite-claim-spinner-stuck"
created: 2026-03-02T00:15:36Z
updated: 2026-03-02T06:52:22Z
---

## Current Focus

hypothesis: Updated role propagation should now happen immediately after invite claim token refresh because auth hydration subscribes to id-token events.
test: Human verify successful claim flow for a newly invited user and confirm destination page no longer shows Access Restricted before reload.
expecting: Success path should land directly on the correct role page with no manual reload required.
next_action: wait for human verification response.

## Symptoms

expected: Claim flow should redirect to role destination on success and show explicit inline error on wrong email or invalid invite states.
actual: Frontend remains on loading spinner indefinitely across multiple scenarios.
errors: No obvious backend error in latest logs; claiminvite appears to complete.
reproduction: Open /invite/claim?token=..., sign in with wrong email, correct email, and pre-signed-in account; spinner persists.
started: Reproducible now after recent invite flow changes.

## Eliminated

## Evidence

- timestamp: 2026-03-02T00:15:36Z
  checked: pages/invite/claim.tsx cleanup effect
  found: cleanup sets `mountedRef.current = false` and there is no assignment restoring it to true inside any effect body.
  implication: once cleanup runs, async handlers that check `mountedRef.current` can early return forever.

- timestamp: 2026-03-02T00:15:36Z
  checked: next.config.js strict mode setting
  found: `reactStrictMode: true` is enabled.
  implication: development mode replays effect setup/cleanup, which can trigger the mountedRef false bug without real unmount.

- timestamp: 2026-03-02T00:15:36Z
  checked: pages/invite/claim.tsx async flow guards
  found: success path, catch path, and auth timeout callback all bail out when `mountedRef.current` is false.
  implication: claim status can remain `loading`/`claiming`/`redirecting` indefinitely with no terminal update.

- timestamp: 2026-03-02T00:15:36Z
  checked: pages/invite/claim.tsx mount effect setup
  found: added `mountedRef.current = true` at effect start before cleanup assignment.
  implication: Strict Mode replay restores mounted state and allows async branches to commit redirect/error state updates.

- timestamp: 2026-03-02T00:15:36Z
  checked: verification commands
  found: `pnpm lint` fails on pre-existing unrelated lint errors in admin/uploader files; no new lint error reported for invite claim page.
  implication: repository has baseline lint failures; full lint pass cannot be used as success signal for this change.

- timestamp: 2026-03-02T06:50:08Z
  checked: human verification checkpoint response
  found: spinner issue is fixed, but successful claim for newly invited user lands on access restricted until manual reload; after reload, correct role page appears.
  implication: original spinner root cause is resolved, but a second bug remains in post-claim auth/role propagation during redirect.

- timestamp: 2026-03-02T06:51:29Z
  checked: invite claim success path (`pages/invite/claim.tsx`)
  found: after `claiminvite` returns success, page forces `firebaseUser.getIdToken(true)` and immediately redirects.
  implication: claim flow depends on token refresh for updated claims, but does not itself update auth context state.

- timestamp: 2026-03-02T06:51:29Z
  checked: auth hydration logic (`context/user/UserContext.tsx`)
  found: provider subscribes to `auth.onAuthStateChanged` only; it rebuilds `user.role` and `token` cookie only when auth state changes.
  implication: claim-triggered custom claim refresh does not propagate to context/cookie until full app remount or sign-out/in cycle.

- timestamp: 2026-03-02T06:51:29Z
  checked: access restricted gate (`layout/AppLayout.tsx`)
  found: layout renders Access Restricted when `!user.canUpload()`.
  implication: stale `user.role='user'` after claim explains observed restricted landing until manual reload.

- timestamp: 2026-03-02T06:52:22Z
  checked: fix implementation (`context/user/UserContext.tsx`)
  found: auth hydration listener changed from `onAuthStateChanged` to `onIdTokenChanged`.
  implication: token refresh from invite claim now triggers role/cookie hydration without requiring a full app reload.

- timestamp: 2026-03-02T06:52:22Z
  checked: targeted lint verification
  found: `pnpm exec next lint --file context/user/UserContext.tsx --file pages/invite/claim.tsx` passes with no warnings/errors.
  implication: touched files satisfy project lint rules.

- timestamp: 2026-03-02T06:52:22Z
  checked: project typecheck verification
  found: `pnpm exec tsc -p tsconfig.json --noEmit` fails on pre-existing unrelated missing `operationKey` fields in admin/subsplash files.
  implication: full typecheck baseline is red; this change cannot be fully validated via global tsc in current branch state.

## Resolution

root_cause: Two linked issues in invite claim flow: (1) spinner stuck because mounted ref was never reset in Strict Mode effect replay; (2) post-claim redirect showed Access Restricted because role hydration listened only to auth-state changes, not id-token/claim refresh events.
fix: (1) Reset `mountedRef.current = true` in invite claim mount effect (`pages/invite/claim.tsx`). (2) Change user hydration listener to `onIdTokenChanged` in `context/user/UserContext.tsx` so claim-triggered token refresh updates `user.role` and auth cookie immediately.
verification: Human checkpoint confirmed spinner fix. New fix is code-path verified and targeted lint verified; pending human workflow verification that successful claim no longer requires manual reload.
files_changed: ["pages/invite/claim.tsx", "context/user/UserContext.tsx"]
