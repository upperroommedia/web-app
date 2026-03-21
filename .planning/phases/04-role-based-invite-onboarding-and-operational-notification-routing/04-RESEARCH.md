# Phase 4: Role-based invite onboarding and operational notification routing - Research

**Researched:** 2026-03-01
**Domain:** Firebase Auth role assignment + invite token lifecycle + operational email/alert routing
**Confidence:** MEDIUM

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

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

### Deferred Ideas (OUT OF SCOPE)

- None. Discussion stayed within phase scope.
  </user_constraints>

## Summary

Phase 4 should be implemented as three explicit backend surfaces plus one frontend claim flow: (1) admin invite issuance + claim, (2) role-request creation + notification fanout, and (3) a shared operational alert utility invoked from caught runtime error paths. The current codebase already has role claim primitives (`setUserRoleOnCreate`, `setUserRole`) and typed callable wiring (`createFunctionV2`), but has no invite lifecycle model and no outbound email pipeline.

The safest invite implementation is a hashed-token Firestore artifact with transactional state transitions. Do not store raw invite tokens. Generate high-entropy invite tokens (`crypto.randomBytes`), store only `sha256(token)`, enforce email equality at claim time, and preserve single-use with transaction-guarded status transitions. Use Firebase Auth Admin APIs for claim updates and refresh-token revocation so changed roles propagate cleanly.

For notification routing, use a queue/outbox pattern and parameterized config (not legacy runtime config). Recommendation is the official Firebase Trigger Email extension for delivery, with a wrapper in Functions that writes mail docs and structured operational events. This preserves role-request records even when email delivery fails and gives a clear place to emit alert metadata for each caught runtime error occurrence.

**Primary recommendation:** Implement a transactional invite artifact (`roleInvites`) + centralized `emitOperationalAlert()` utility, and route all notification email via a Firestore outbox collection consumed by `firebase/firestore-send-email`.

## Standard Stack

### Core

| Library                     | Version                                 | Purpose                                                                                   | Why Standard                                                 |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `firebase-functions`        | `^6.3.2`                                | Callable/auth triggers, structured logging, params/secrets                                | Already the project backend runtime and auth extension point |
| `firebase-admin`            | `^13.4.0`                               | Auth claim updates (`setCustomUserClaims`, `revokeRefreshTokens`), Firestore transactions | Existing backend authority path for roles/users              |
| `firebase-functions/params` | `^6.3.2` (part of `firebase-functions`) | Environment-configurable recipient routing (`defineList`, `defineString`, `defineSecret`) | Official replacement for deprecated `functions.config()`     |
| Cloud Firestore             | Managed                                 | Invite state, role-request records, notification outbox, event/alert records              | Existing system of record and transaction engine             |

### Supporting

| Library                                            | Version                   | Purpose                                                                  | When to Use                                           |
| -------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| Firebase Extension `firebase/firestore-send-email` | latest extension release  | Send outbound emails from Firestore message docs                         | Role request notifications + operational alert emails |
| Node `node:crypto`                                 | Node `22` runtime builtin | Secure invite token generation and hash/compare                          | Invite issue + claim validation                       |
| `axios`                                            | `^1.6.5`                  | Optional fallback/alternate delivery adapter if extension is unavailable | Only if extension is blocked by infra policy          |

### Alternatives Considered

| Instead of                                            | Could Use                                   | Tradeoff                                                                |
| ----------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| Firestore outbox + Trigger Email extension (selected) | Direct SMTP/API calls inside every callable | Higher coupling and more failure handling in hot paths                  |
| Hashed invite tokens (selected)                       | Store plaintext invite tokens               | Increases risk if Firestore read exposure occurs                        |
| Firestore TTL for passive cleanup (selected)          | Scheduled cleanup-only cron                 | More custom maintenance code for an already-supported retention feature |

**Installation:**

```bash
# Extension install (prod project)
firebase ext:install firebase/firestore-send-email --project=<project-id>

# Optional local extension emulation
firebase ext:install --local firebase/firestore-send-email
```

## Architecture Patterns

### Recommended Project Structure

```
functions/src/
├── invites/
│   ├── inviteTypes.ts                # invite schema + role ranking + validation
│   ├── createInvite.ts               # admin callable: issue invite token
│   ├── claimInvite.ts                # authenticated callable: validate + consume + role assign
│   └── inviteToken.ts                # randomBytes/hash helpers
├── notifications/
│   ├── notificationParams.ts         # defineList/defineString params for recipients/links
│   ├── queueEmail.ts                 # writes outbox doc for extension
│   ├── emitOperationalAlert.ts       # shared error alert utility
│   └── notifyRoleRequestCreated.ts   # trigger or callable helper for new role-request notifications
├── roleRequests/
│   └── createRoleRequest.ts          # callable that writes role request + notification side effect
└── index.ts                          # exports new callables/triggers

pages/
├── invite/claim.tsx                  # claim-entry page (token -> login -> callable claim)
└── invite/success.tsx                # post-claim success destination

components/
└── RequestUploadPrivalige.tsx        # replace TODO submit with createRoleRequest callable
```

### Pattern 1: Admin Invite Issuance With Hashed Tokens

**What:** Admin-only callable creates a 30-day invite artifact and returns a claim URL containing raw token.
**When to use:** Any privileged role onboarding that bypasses manual approval.
**Example:**

```typescript
// Source: https://nodejs.org/api/crypto.html
// Source: https://firebase.google.com/docs/functions/callable
import { randomBytes, createHash } from 'node:crypto';

const rawToken = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(rawToken).digest('hex');

// Store only tokenHash in Firestore; return raw token in generated URL.
```

### Pattern 2: Transactional Claim State + Role Assignment

**What:** Claim callable validates invite + email match + expiration in Firestore transaction, then applies role claim update and refresh-token revocation.
**When to use:** Invite consumption where single-use and non-downgrade semantics are required.
**Example:**

```typescript
// Source: https://firebase.google.com/docs/firestore/manage-data/transactions
// Source: https://firebase.google.com/docs/auth/admin/custom-claims
// Source: https://firebase.google.com/docs/auth/admin/manage-sessions
await firestore.runTransaction(async (tx) => {
  const snap = await tx.get(inviteRef);
  // validate: exists, not expired, email matches, not already consumed
  tx.update(inviteRef, {
    claimStatus: 'ROLE_PENDING',
    consumedByUid: authUid,
    consumedAtMs: Date.now(),
  });
});

const user = await auth.getUser(authUid);
const mergedClaims = { ...(user.customClaims ?? {}), role: resolvedHighestRole };
await auth.setCustomUserClaims(authUid, mergedClaims);
await auth.revokeRefreshTokens(authUid);
```

### Pattern 3: Outbox Email Routing (Do Not Block Data Commit)

**What:** Persist business record first, then enqueue notification email as separate side effect and log alert if enqueue fails.
**When to use:** New role request creation.
**Example:**

```typescript
// Source: https://firebase.google.com/docs/extensions/official/firestore-send-email
await roleRequestsRef.add(roleRequestPayload); // primary write must succeed regardless

try {
  await mailRef.add({
    to: roleRequestRecipients,
    message: {
      subject: 'New role request',
      html: renderHtml(roleRequestPayload),
    },
    meta: { type: 'role_request_created' },
  });
} catch (error) {
  await emitOperationalAlert('ROLE_REQUEST_EMAIL_ENQUEUE_FAILED', error, context);
}
```

### Pattern 4: Centralized Runtime Error Alert Helper

**What:** Shared helper writes structured log/event + outbox email for each caught runtime error occurrence.
**When to use:** Every `catch` path in upload/audio and other operationally sensitive functions.
**Example:**

```typescript
// Source: https://firebase.google.com/docs/functions/writing-and-viewing-logs
logger.error('runtime_error', {
  code: 'AUDIO_PROCESSING_FAILURE',
  functionName,
  operationKey,
  entityId,
  errorMessage,
});

await queueEmail({
  to: operationalRecipients,
  message: {
    subject: `[URM] Runtime error: ${functionName}`,
    text: JSON.stringify(alertPayload, null, 2),
  },
});
```

### Anti-Patterns to Avoid

- **Plaintext invite token persistence:** Store hash only; plaintext token should only exist in generated link.
- **Role claim overwrite without merge:** `setCustomUserClaims` replaces claims map; always merge existing claims first.
- **Notification-only transaction coupling:** Never fail role-request creation just because notification enqueue failed.
- **Ad-hoc error strings as contracts:** Existing mixed `return 'error string'` patterns cause brittle clients and weak observability.
- **Client-direct mail writes without strict rules:** Protect mail/outbox collections from arbitrary client writes.

## Don't Hand-Roll

| Problem                          | Don't Build                                      | Use Instead                                                | Why                                                                    |
| -------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Email delivery transport         | Custom SMTP retry/state machine in each function | `firebase/firestore-send-email` extension + outbox docs    | Standardized delivery status states and lower function-path complexity |
| Invite token entropy/security    | UUID-only or guessable token formats             | `crypto.randomBytes` + SHA-256 token hash                  | Strong entropy and safer persistence model                             |
| Single-use consume race handling | Non-transactional read-then-write invite checks  | Firestore transaction state transitions                    | Prevents multi-claim races and partial state                           |
| Runtime config management        | `functions.config()`                             | `firebase-functions/params` (`defineList`, `defineSecret`) | Official current path; legacy config is deprecated/decommissioning     |

**Key insight:** The hard part is not generating links; it is preserving correctness under race/failure while keeping notifications observable and non-blocking.

## Common Pitfalls

### Pitfall 1: Claim Update Overwrites Existing Claims

**What goes wrong:** Updating `role` drops unrelated existing custom claims.
**Why it happens:** `setCustomUserClaims` replaces the entire claims object.
**How to avoid:** Read current claims first, merge explicitly, then set.
**Warning signs:** Users lose unrelated permissions/flags after invite claim.

### Pitfall 2: Invite Token Reuse or Race

**What goes wrong:** Two near-simultaneous claims both appear valid.
**Why it happens:** Non-transactional validation/consume logic.
**How to avoid:** Transactional claim-state transition (`PENDING` -> `ROLE_PENDING` -> `COMPLETE`).
**Warning signs:** Duplicate claim logs for same invite within seconds.

### Pitfall 3: Email Delivery Failure Breaks Core Flow

**What goes wrong:** Role request creation fails when notifier is down.
**Why it happens:** Tight coupling of data commit and outbound network call.
**How to avoid:** Commit request first, then enqueue email; alert on enqueue failure.
**Warning signs:** Missing role requests when SMTP provider has incidents.

### Pitfall 4: Assuming TTL Deletes Immediately

**What goes wrong:** Expired invites remain query-visible for some time.
**Why it happens:** TTL deletion is asynchronous and not instantaneous.
**How to avoid:** Always enforce `expiresAt` check in claim logic; use TTL only for cleanup.
**Warning signs:** “Expired” invites still present in Firestore long enough to confuse manual audits.

### Pitfall 5: Blocking Trigger Assumptions Leak into Claim Flow

**What goes wrong:** Auth creation behavior expected to enforce all invite semantics.
**Why it happens:** `beforeUserCreated` triggers are global and time-bounded.
**How to avoid:** Keep invite claim logic in explicit callable flow; blocking trigger only for baseline defaults.
**Warning signs:** Authentication failures or latency spikes tied to heavy trigger logic.

## Code Examples

Verified patterns from official sources:

### Parameterized Recipient Routing

```typescript
// Source: https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.params
import { defineList } from 'firebase-functions/params';

export const roleRequestRecipients = defineList('ADMIN_REQUEST_RECIPIENTS', {
  default: ['youssef.a.asaad@gmail.com', 'contact@upperroommedia.org'],
});
```

### Callable Auth + Role Guard

```typescript
// Source: https://firebase.google.com/docs/functions/callable
if (!request.auth?.uid) {
  throw new HttpsError('unauthenticated', 'Sign-in is required.');
}
if (request.auth.token.role !== 'admin') {
  throw new HttpsError('permission-denied', 'Admin role required.');
}
```

### Force Claim Propagation After Role Change

```typescript
// Source: https://firebase.google.com/docs/auth/admin/manage-sessions
await auth.setCustomUserClaims(uid, mergedClaims);
await auth.revokeRefreshTokens(uid);
// Client should refresh token after success: currentUser.getIdToken(true)
```

### Trigger Email Extension Outbox Write

```typescript
// Source: https://firebase.google.com/docs/extensions/official/firestore-send-email
await firestore.collection('mail').add({
  to: ['ops@example.com'],
  message: {
    subject: 'Operational alert',
    text: 'Runtime error details here',
  },
});
```

## State of the Art

| Old Approach                               | Current Approach                                           | When Changed                                                                              | Impact                                                           |
| ------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `functions.config()` runtime config        | `firebase-functions/params` + secrets                      | `functions.config` deprecated in `firebase-functions` v6; new deploys fail after Dec 2025 | Phase 4 should not introduce legacy config debt                  |
| Plain `console.*` logs with mixed payloads | Structured logger payloads + execution ID correlation      | Cloud Run functions log execution ID support in Firebase CLI `13.33.0+`                   | Better per-request traceability for operational alerts           |
| Ad-hoc invite cleanup scripts              | Firestore TTL retention + claim-time expiration checks     | Firestore TTL now standard and documented                                                 | Lower maintenance burden; still must enforce expiry at read time |
| Direct provider call in every catch block  | Outbox + extension transport with centralized alert helper | Mature extension docs/emulator flow available                                             | Decouples delivery from core mutation paths                      |

**Deprecated/outdated:**

- `functions.config()` for new configuration work.
- Plaintext invite token persistence.
- Notification logic duplicated inside each callable.

## Open Questions

1. **Extension policy acceptance**

   - What we know: Trigger Email extension is a strong fit and officially documented.
   - What's unclear: Whether team policy allows adding Firebase Extensions to production projects.
   - Recommendation: Confirm in Wave 0. If rejected, substitute a single provider adapter service with identical outbox contract.

2. **Invite claim failure-retry UX**

   - What we know: Role update can fail after initial consume transition.
   - What's unclear: Whether to expose automatic retry to the same claimant or force admin repair path.
   - Recommendation: Allow same claimant retry while `claimStatus=ROLE_FAILED`; alert ops on each failure.

3. **Role precedence contract**
   - What we know: No implicit downgrade allowed.
   - What's unclear: Final rank ordering between `uploader` and `publisher` in all edge cases.
   - Recommendation: Lock explicit precedence map in code (`user < uploader < publisher < admin`) and reference in tests.

## Sources

### Primary (HIGH confidence)

- Local code evidence:
  - `functions/src/setUserRoleOnCreate.ts`
  - `functions/src/setUserRole.ts`
  - `functions/src/index.ts`
  - `components/RequestUploadPrivalige.tsx`
  - `components/uploaderComponents/VerifiedUserUploaderComponent.tsx`
  - `utils/createFunction.ts`
  - `functions/src/addIntroOutro/addintrooutrotaskgenerator.ts`
  - `functions/src/addIntroOutro/addintrooutrotaskhandler.ts`
  - `functions/src/uploadToSoundCloud.ts`
  - `functions/src/uploadToSubsplash.ts`
- Official docs:
  - https://firebase.google.com/docs/functions/callable
  - https://firebase.google.com/docs/auth/admin/custom-claims
  - https://firebase.google.com/docs/auth/admin/manage-sessions
  - https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.baseauth
  - https://firebase.google.com/docs/functions/config-env
  - https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.params
  - https://firebase.google.com/docs/functions/writing-and-viewing-logs
  - https://firebase.google.com/docs/firestore/manage-data/transactions
  - https://firebase.google.com/docs/firestore/ttl
  - https://firebase.google.com/docs/extensions/official/firestore-send-email
  - https://firebase.google.com/docs/extensions/official/firestore-send-email/delivery-status
  - https://firebase.google.com/docs/emulator-suite/use_extensions
  - https://firebase.google.com/docs/auth/extend-with-blocking-functions
  - https://nodejs.org/api/crypto.html

### Secondary (MEDIUM confidence)

- https://cloud.google.com/firestore/docs/ttl (TTL operational behavior details mirrored from Firebase docs)

### Tertiary (LOW confidence)

- None.

## Metadata

**Confidence breakdown:**

- Standard stack: **HIGH** - Based on current repository dependencies and official Firebase/Node docs.
- Architecture: **MEDIUM** - Core patterns are well-supported; extension policy and retry UX are still open.
- Pitfalls: **HIGH** - Confirmed by official docs and current codebase gaps.

**Research date:** 2026-03-01
**Valid until:** 2026-03-31 (30 days)
