# Phase 3: Subsplash alpha-lock concurrency control - Research

**Researched:** 2026-03-01
**Domain:** Distributed lock coordination + idempotent callable mutations for Subsplash-linked writes
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Lock Scope and Ownership
- Locking is entity-based across mutation paths:
  - series lock for series mutations
  - list lock for list mutations
  - sermon/media-item lock for sermon/media-item mutations
- Any mutation path must acquire the relevant lock(s) before making writes.
- If multiple locks are required, acquire them using a global deterministic ordering rule (entity type order, then entity ID order).
- Lock acquisition/release is owned by Cloud Functions only (clients do not manage locks).
- Any read used to decide writes must happen only after lock acquisition (read-after-lock always).

### Wait/Timeout and Contention Contract
- On lock contention, operations wait with bounded timeout (not fail-fast by default).
- Initial lock wait timeout target: 10 seconds.
- Retry policy is caller-controlled: function returns a structured busy response and caller decides retry behavior.
- Standard contention error payload should include:
  - machine-readable busy code
  - locked entity key(s)
  - wait_ms attempted
  - retry_after_ms hint

### Recovery, Stale Locks, and Idempotency
- Use TTL + heartbeat for stale lock reclamation.
- Lock state store: Realtime Database (RTDB).
- Mutation endpoints use per-operation idempotency keys so retries do not duplicate side effects.
- Enforce hard release guarantees (finally-block release paths) plus dead-letter/error logging for orphaned release failures.

### Claude's Discretion
- Exact TTL and heartbeat intervals.
- Exact retry-after calculation strategy.
- Lock record schema details in RTDB.
- Dead-letter sink implementation details (logging channel/collection/topic).

### Deferred Ideas (OUT OF SCOPE)
- None — discussion stayed within phase scope.
</user_constraints>

## Summary

Current mutation callables are vulnerable to race conditions because they run in Cloud Functions v2 (multi-request concurrency per instance) and execute external Subsplash writes without a cross-request lock layer. High-risk paths are `addToSeries`, `removeFromSeries`, `reorderSeriesItems`, `addToList`, `removeFromList`, and `uploadToSubsplash`; some of these flows also mix external API calls with Firestore transaction retries, which is already producing retry/inconsistency bugs in existing tests.

The correct shape for this phase is a shared server-side lock utility in `functions/src` backed by RTDB transactional compare-and-set, with deterministic multi-lock ordering, lease heartbeat, stale lock takeover, and release ownership checks. Every mutation path must execute read-after-lock and wrap external side effects with an idempotency envelope keyed by client-provided operation IDs.

Frontend and admin pages already use `createFunctionV2` and inspect callable error `code/message/details`, so returning structured contention metadata through `HttpsError.details` is compatible with existing integration points. This phase should standardize one busy contract and avoid ad-hoc retries in UI code.

**Primary recommendation:** Implement a reusable `withSubsplashLocks + withIdempotency` backend wrapper and migrate all Subsplash-linked mutation callables to it before adding any new publishing behavior.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `firebase-functions` | `^6.3.2` | Callable endpoints + structured `HttpsError` responses | Existing callable surface already standardized on v2 APIs |
| `firebase-admin` | `^13.4.0` | RTDB transaction-based lock store + Firestore idempotency/result store | Already initialized in backend; no new infra dependency |
| `axios` | `^1.6.5` | Subsplash API calls | Existing helper pattern (`createAxiosConfig`) already centralized |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `jest` | `^29.7.0` | Concurrency and retry regression tests | Function-unit/emulator tests for lock contention and idempotency |
| `ts-jest` | `^29.4.0` | TypeScript test runtime | Existing `functions/jest.config.js` setup |
| Firebase Emulator Suite | via `firebase-tools` | Deterministic local lock/contention testing | Required for Firestore/RTDB transaction behavior validation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| RTDB lock rows (selected) | Firestore lock docs | Higher lock latency and write contention cost for rapid lease heartbeat loops |
| RTDB lock rows (selected) | In-memory process mutex | Fails across instances and cannot handle Cloud Functions v2 horizontal/instance concurrency |
| Built-in callable retries (manual caller retries selected) | Server auto-retry loops | Harder to provide deterministic user feedback and can duplicate side effects without idempotency |

**Installation:**
```bash
# No new package required for Phase 3 baseline.
# Reuse existing firebase-admin/firebase-functions/axios stack.
```

## Architecture Patterns

### Recommended Project Structure
```
functions/src/
├── locks/
│   ├── subsplashLockStore.ts      # RTDB lock acquire/heartbeat/release primitives
│   ├── withSubsplashLocks.ts      # deterministic multi-lock orchestration wrapper
│   ├── idempotencyStore.ts         # operation key claim/result persistence
│   └── contentionError.ts          # standard busy payload and HttpsError factory
├── addToSeries.ts                  # migrated to lock/idempotency wrapper
├── removeFromSeries.ts             # migrated to lock/idempotency wrapper
├── reorderSeriesItems.ts           # migrated to lock/idempotency wrapper
├── addToList.ts                    # migrated to lock/idempotency wrapper
├── removeFromList.ts               # migrated to lock/idempotency wrapper
└── uploadToSubsplash.ts            # migrated to lock/idempotency wrapper
```

### Pattern 1: RTDB Lease Lock With Transaction Claim
**What:** Claim lock atomically at `subsplashLocks/{entityType}:{entityId}` via RTDB transaction, using owner token + lease expiry.
**When to use:** Any mutation that can race on same series/list/media-item.
**Example:**
```typescript
// Source: Firebase RTDB transaction docs + firebase-admin.database ServerValue
import firebaseAdmin from '../../firebase/firebaseAdmin';

type LockRecord = {
  owner: string;
  leaseExpiresAtMs: number;
  heartbeatAtMs: unknown;
  operationKey?: string;
};

export async function tryAcquireLock(lockKey: string, owner: string, leaseMs: number): Promise<boolean> {
  const ref = firebaseAdmin.database().ref(`subsplashLocks/${lockKey}`);
  const now = Date.now();

  const tx = await ref.transaction((current: LockRecord | null) => {
    const expired = !current || current.leaseExpiresAtMs <= now;
    if (!expired && current.owner !== owner) return; // abort claim

    return {
      owner,
      leaseExpiresAtMs: now + leaseMs,
      heartbeatAtMs: firebaseAdmin.database.ServerValue.TIMESTAMP,
    } satisfies LockRecord;
  });

  return tx.committed === true;
}
```

### Pattern 2: Deterministic Multi-Lock Wrapper
**What:** Sort lock keys globally before acquisition (`entityType`, then `entityId`), acquire in order, release in reverse order in `finally`.
**When to use:** Any callable touching more than one lock domain.
**Example:**
```typescript
// Source: locked decision (global order) + existing callable pattern
const ENTITY_ORDER = ['series', 'list', 'media-item'] as const;

function sortLockKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const [typeA, idA] = a.split(':');
    const [typeB, idB] = b.split(':');
    const t = ENTITY_ORDER.indexOf(typeA as (typeof ENTITY_ORDER)[number]) -
      ENTITY_ORDER.indexOf(typeB as (typeof ENTITY_ORDER)[number]);
    return t !== 0 ? t : idA.localeCompare(idB);
  });
}

export async function withSubsplashLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const acquired: string[] = [];
  const ordered = sortLockKeys(keys);
  try {
    for (const key of ordered) {
      await acquireWithWait(key, { timeoutMs: 10_000 });
      acquired.push(key);
    }
    return await fn();
  } finally {
    await Promise.allSettled(acquired.reverse().map((key) => releaseIfOwned(key)));
  }
}
```

### Pattern 3: Idempotency Envelope Around Side Effects
**What:** Claim operation key before external mutation; persist terminal result; replay same result for duplicate requests.
**When to use:** Every callable where client retry is possible.
**Example:**
```typescript
// Source: Cloud Functions idempotency best-practice docs + current callable flows
export async function withIdempotency<T>(
  opKey: string,
  run: () => Promise<T>
): Promise<T> {
  const existing = await idempotencyStore.get(opKey);
  if (existing?.status === 'completed') return existing.result as T;

  const claimed = await idempotencyStore.claim(opKey);
  if (!claimed && existing?.status === 'in_progress') {
    throw busyError({ code: 'SUBSPLASH_LOCK_BUSY', operation_key: opKey });
  }

  try {
    const result = await run();
    await idempotencyStore.complete(opKey, result);
    return result;
  } catch (error) {
    await idempotencyStore.fail(opKey, error);
    throw error;
  }
}
```

### Pattern 4: Standard Busy Callable Contract
**What:** Throw `HttpsError` with structured `details` payload for contention.
**When to use:** Lock wait timeout exceeded or lock takeover denied.
**Example:**
```typescript
// Source: callable error docs (code/message/details)
import { HttpsError } from 'firebase-functions/v2/https';

throw new HttpsError('aborted', 'Lock contention on Subsplash mutation', {
  code: 'SUBSPLASH_LOCK_BUSY',
  locked_keys: ['series:abc123', 'media-item:def456'],
  wait_ms: 10_000,
  retry_after_ms: 1500,
});
```

### Anti-Patterns to Avoid
- **Network I/O inside Firestore transactions:** Firestore transaction callbacks can rerun; existing list tests already expose duplicate/inconsistency risk.
- **Process-local mutexes:** They do not coordinate across Cloud Functions instances.
- **Unlock without owner check:** Risks releasing another in-flight invocation's lease.
- **Fail-open contention behavior:** Returning ambiguous generic errors blocks caller-controlled retry strategy.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Cross-instance mutual exclusion | In-memory `Map`/global variable lock | RTDB transaction lock rows | Cloud Functions v2 runs concurrent requests across instances |
| Retry deduplication | UI-only retry counters | Backend idempotency key store with terminal result replay | Prevents duplicate external side effects |
| Lock contention signaling | Free-form strings/alerts | One structured `HttpsError.details` schema | Required for deterministic caller retry logic |
| Stale-lock cleanup | Manual operator cleanup only | TTL lease + heartbeat + takeover logic | Survives crashed invocations and partial failures |

**Key insight:** In this domain, correctness failures come from re-entrancy and partial side effects, not raw throughput. Transactional lock claim + idempotency keying is mandatory infrastructure, not optional hardening.

## Common Pitfalls

### Pitfall 1: Firestore Transaction Retry Replays External Side Effects
**What goes wrong:** External Subsplash calls run inside Firestore transaction callback and replay when transaction retries.
**Why it happens:** Firestore transaction function can execute multiple times under concurrent edits.
**How to avoid:** Move external calls outside Firestore transaction; use lock + idempotency wrapper for side effects.
**Warning signs:** Tests like `transactionRetryInconsistency` / `transactionRetryDuplication` fail intermittently; overflow chains diverge between Subsplash and Firestore.

### Pitfall 2: Deadlock From Inconsistent Multi-Lock Ordering
**What goes wrong:** Two invocations each hold one lock and wait forever for the other.
**Why it happens:** Different acquisition order across callables.
**How to avoid:** Single global sort rule (`entity type`, then `entity ID`) used everywhere.
**Warning signs:** Elevated timeouts with no direct API failures; lock records remain active near full timeout windows.

### Pitfall 3: Orphan Lock From Missing Finally Release
**What goes wrong:** Exception path exits without release, blocking future mutations until TTL expiry.
**Why it happens:** Lock lifecycle not centralized.
**How to avoid:** Wrapper-enforced `try/finally` and release ownership checks.
**Warning signs:** Repeated `SUBSPLASH_LOCK_BUSY` for same entity despite no active mutation.

### Pitfall 4: Emulator Misconfiguration Sends Lock Writes to Production RTDB
**What goes wrong:** Local tests/dev accidentally mutate live lock store.
**Why it happens:** `FIREBASE_DATABASE_EMULATOR_HOST` not set for Admin SDK paths.
**How to avoid:** Enforce emulator env var in test bootstrap and local scripts.
**Warning signs:** Local lock behavior appears inconsistent with emulator data viewer; prod lock nodes appear during local runs.

## Code Examples

Verified patterns from official sources and current codebase:

### RTDB Transaction Retry-Safe Lock Claim
```typescript
// Source: https://firebase.google.com/docs/database/admin/save-data
// Source: https://firebase.google.com/docs/reference/admin/node/firebase-admin.database
await db.ref(`subsplashLocks/${lockKey}`).transaction((current) => {
  const now = Date.now();
  const expired = !current || current.leaseExpiresAtMs <= now;
  if (!expired && current.owner !== owner) return;
  return {
    owner,
    leaseExpiresAtMs: now + leaseMs,
    heartbeatAtMs: firebaseAdmin.database.ServerValue.TIMESTAMP,
  };
});
```

### Callable Busy Error With Structured Details
```typescript
// Source: https://firebase.google.com/docs/functions/callable
import { HttpsError } from 'firebase-functions/v2/https';

throw new HttpsError('aborted', 'Lock contention on Subsplash mutation', {
  code: 'SUBSPLASH_LOCK_BUSY',
  locked_keys: lockKeys,
  wait_ms: waitedMs,
  retry_after_ms: retryAfterMs,
});
```

### Read-After-Lock Wrapper Integration
```typescript
// Source: existing callable pattern in addToSeries/reorderSeriesItems/addToList
return withSubsplashLocks(['series:' + seriesId, 'media-item:' + mediaItemId], async () => {
  const fresh = await readCurrentStateAfterLock();
  const result = await mutateSubsplash(fresh);
  await persistFirestoreState(result);
  return result;
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Assume single-flight callable execution | Design for Cloud Functions v2 concurrent request handling (default concurrency on CPU>=1) | Cloud Functions v2 adoption | Requires explicit cross-request lock coordination |
| Perform external side effects inside Firestore transaction callback | Keep Firestore tx for DB state only; external writes behind distributed lock + idempotency | Firestore transaction retry semantics (current docs) | Prevents replay/duplication under transaction retries |
| Generic client error handling | Structured contention payload in callable `details` | Existing callable error contract supports details | Enables deterministic UI retry/backoff behavior |

**Deprecated/outdated:**
- **Process-local lock-only strategy:** invalid under multi-instance/serverless concurrency.
- **Retry without idempotency key:** unsafe for external mutation side effects.

## Open Questions

1. **Mutation surface completeness for lock rollout**
   - What we know: Context explicitly targets series/list/sermon mutation callables and references six key entry points.
   - What's unclear: Whether `createSeries`, `deleteSeries`, `editSubsplashSermon`, and `deleteFromSubsplash` are in Phase 3 scope or follow-up.
   - Recommendation: Lock required-callable list in planning Wave 0 before task split.

2. **Idempotency record backend and retention policy**
   - What we know: Per-operation idempotency is required.
   - What's unclear: Firestore vs RTDB for idempotency records, retention TTL, and cleanup job ownership.
   - Recommendation: Choose Firestore collection with TTL field if available in project policy, otherwise scheduled cleanup task.

3. **Dead-letter sink implementation detail**
   - What we know: Orphan release failures must be logged to dead-letter sink.
   - What's unclear: Whether sink is Cloud Logging-only, Firestore collection, or Pub/Sub topic.
   - Recommendation: Use Cloud Logging structured error + Firestore `lockReleaseFailures` fallback document for operator triage.

## Sources

### Primary (HIGH confidence)
- Local codebase evidence:
  - `functions/src/addToList.ts` (Firestore transaction + external Subsplash calls + retry-sensitive logic)
  - `functions/src/addToSeries.ts`, `removeFromSeries.ts`, `reorderSeriesItems.ts`, `removeFromList.ts`, `uploadToSubsplash.ts`
  - `functions/src/test/addToList/transactionRetryInconsistency.test.ts`
  - `functions/src/test/addToList/transactionRetryDuplication.test.ts`
  - `functions/src/test/addToList/concurrentAccess.test.ts`
  - `utils/createFunction.ts` (callable wrapper integration shape)
- Firebase docs:
  - https://firebase.google.com/docs/database/admin/save-data (RTDB transactions, retry behavior, null handling)
  - https://firebase.google.com/docs/database/web/read-and-write (transaction retry semantics)
  - https://firebase.google.com/docs/functions/manage-functions (Cloud Functions v2 concurrency model)
  - https://firebase.google.com/docs/functions/callable (callable error contract: `code/message/details`)
  - https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.https.httpserror (`HttpsError` details payload)
  - https://firebase.google.com/docs/emulator-suite/connect_rtdb (Admin SDK RTDB emulator env var)
  - https://firebase.google.com/docs/reference/admin/node/firebase-admin.database (Admin DB API + `ServerValue` availability)
  - https://firebase.google.com/docs/firestore/manage-data/transactions (transaction retry and callback constraints)
  - https://firebase.google.com/docs/functions/tips (idempotent function guidance)

### Secondary (MEDIUM confidence)
- https://firebase.google.com/docs/admin/setup (SDK init guidance and `FIREBASE_CONFIG` behavior)

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** - Directly verified from `package.json` files and current function imports.
- Architecture: **MEDIUM** - Core lock/idempotency pattern is strongly supported by Firebase semantics; exact schema/time values remain discretionary.
- Pitfalls: **HIGH** - Confirmed by existing local failing-risk tests and documented transaction retry behavior.

**Research date:** 2026-03-01
**Valid until:** 2026-03-31 (30 days; stack/docs are stable, implementation details are local and can drift quickly)
