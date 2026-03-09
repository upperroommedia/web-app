# Phase 4: Role-based invite onboarding and operational notification routing - Context

**Gathered:** 2026-03-01
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers three connected capabilities only:
1. Admin-created invite links that assign a target role without requiring a separate role-request approval loop.
2. Notification delivery for new user role requests.
3. Operational error notifications for runtime failures (including upload and audio processing flows).

New capabilities outside this boundary should be deferred to separate phases.

</domain>

<decisions>
## Implementation Decisions

### Invite Link Model
- Invite claim requires authentication and strict email match against the invited email.
- Invite links expire after 30 days.
- Invites are single-use and must be marked consumed on first successful claim.
- Only admins can create invites, and admins can assign any supported role.

### Auto Role Assignment
- Role assignment happens immediately at successful invite claim (no delayed/manual approval step).
- If invited email already has an account at role `user`, upgrade that existing account in place.
- If current role is higher than invite target, keep the highest role (no implicit downgrade).
- After successful claim, user is redirected to a dedicated invite success page.

### Role Request Email Notifications
- Send notification emails only when a new role request is created.
- Recipient routing is environment-configurable.
- Production/default recipient set must include both `youssef.a.asaad@gmail.com` and `contact@upperroommedia.org`.
- If email delivery fails, preserve the role request and emit an operational alert/log signal.
- Notification payload must include requester identity, requested target role, timestamp, and a direct admin link.

### Runtime Error Alerting
- Alert on all caught runtime errors (not only critical-pipeline subset).
- Use email alerts plus structured logging/events for traceability.
- Alert recipients are environment-configurable.
- No dedupe window: send notifications for each occurrence.

### Claude's Discretion
- Exact token format/storage model for invite artifacts.
- Exact alert/event schema fields beyond required payload details above.
- Exact invite success page UX copy/layout.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `functions/src/setUserRoleOnCreate.ts`: existing `beforeUserCreated` custom-claim role bootstrap.
- `functions/src/setUserRole.ts`: admin-only callable for role changes and refresh-token revocation.
- `pages/admin/users.tsx` + `components/UserTable.tsx`: existing admin role-management UI patterns.
- `context/user/UserContext.tsx`: existing auth token/claim hydration and role capability helpers.

### Established Patterns
- Role permissions are claim-based and checked in callables (`request.auth?.token.role`).
- Callable responses commonly use `{ status: 'success' | 'error' }` output contracts.
- Error normalization uses shared handling patterns (`handleError.ts`) plus Firebase logger usage.
- Cloud Functions v2 triggers/callables are already in use and are the preferred extension point.

### Integration Points
- New invite issuance/claim callable(s): `functions/src/*` + `functions/src/index.ts` exports.
- Role-request notification trigger path: existing role-request creation flow (to be wired) plus email sender integration.
- Error alert emission path: centralized catch/error boundaries in upload/audio processing callables/tasks.
- Frontend invite entry/redirect handling: login callback handling in `components/Login.tsx` and/or dedicated invite route/page.

### Current Gaps
- No outbound email delivery integration is currently wired in `functions/` dependencies.
- No existing invite artifact lifecycle (issue/consume/expire/revoke) exists yet.

</code_context>

<specifics>
## Specific Ideas

- Invite links should let users bypass the existing role-request approval flow when the invite is valid.
- New user role request notifications should route to:
  - `youssef.a.asaad@gmail.com`
  - `contact@upperroommedia.org`
- Runtime notifications should cover upload/audio processing failures and other caught runtime errors.

</specifics>

<deferred>
## Deferred Ideas

- None. Discussion stayed within phase scope.

</deferred>

---

*Phase: 04-role-based-invite-onboarding-and-operational-notification-routing*
*Context gathered: 2026-03-01*
