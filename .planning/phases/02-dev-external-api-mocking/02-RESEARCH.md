# Phase 2: Dev External API Mocking - Research

**Researched:** 2026-03-08
**Domain:** Firebase Functions external-provider safety policy + deterministic local provider mocks
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Mock Response Contracts
- Mock responses should be provider-shaped (close to real Subsplash/SoundCloud payload structure), not minimal placeholders.
- Determinism should be input-derived: the same request semantics should yield stable IDs/outcomes across retries/reruns.
- Mock coverage should include all publish-path external actions used in local admin flows (not upload-only).
- Default local behavior should be mostly-success mocks; failure scenarios should be opt-in rather than always injected.

### External API Mode Policy
- In emulator and local dev contexts, default behavior is mock mode plus hard blocking of production Subsplash/SoundCloud hosts.
- Missing or invalid external API mode configuration must fail closed immediately (no permissive fallback).
- Developer override is allowed in dev mode via explicit flag(s), and must support enabling real production calls for both Subsplash and SoundCloud when intentionally requested.
- Host blocking scope should focus on production provider hosts (Subsplash/SoundCloud), not blanket-blocking unrelated outbound traffic.

### Claude's Discretion
- Exact naming and shape of mode flags/env vars.
- Exact provider-shaped mock schema depth per endpoint, as long as caller-facing contracts stay deterministic and realistic.
- Exact policy error code taxonomy and message copy, as long as violations remain fail-closed and actionable.

### Deferred Ideas (OUT OF SCOPE)
- None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DEVSAFE-01 | Emulator runtime never sends outbound requests to production Subsplash or SoundCloud hosts. | Centralized URL-host gate in provider adapters (`subsplashUtils.ts`, `soundcloudClient.ts`) plus denylist enforcement test. |
| DEVSAFE-02 | External API mode is fail-closed in emulator runs when policy is violated. | Single policy resolver (`externalApiPolicy`) that throws `HttpsError('failed-precondition')` on missing/invalid mode in emulator/local contexts. |
| DEVSAFE-03 | Local admin publishing/testing flows remain usable through deterministic mocks. | Provider-shaped deterministic mock builders for upload/edit/delete flows, keyed by request semantics and reused across Subsplash/SoundCloud callables. |
| DEVSAFE-04 | Regression checks block reintroduction of direct production endpoint usage in disallowed paths. | Contract test that scans source for direct production host literals outside approved policy files, plus runtime guard tests. |
</phase_requirements>

## Summary

The codebase already has clear boundaries where Phase 2 should be implemented: Subsplash traffic is funneled through `functions/src/subsplashUtils.ts` and SoundCloud through `functions/src/soundcloudClient.ts`, while publish callables (`uploadToSubsplash`, `editSubsplashSermon`, `deleteFromSubsplash`, `uploadToSoundCloud`, `editSoundCloudSermon`, `deleteFromSoundCloud`) are centralized and already normalized to `HttpsError` via `handleError`. This is a strong fit for a single fail-closed policy module and adapter-level host enforcement.

The most reliable implementation is: enforce policy at outbound boundary (not at UI caller), default emulator/local mode to deterministic mock provider behavior, and require explicit override flags to allow production provider traffic in dev. This avoids accidental production requests while preserving local publish usability. Existing tests already use provider mocks and contract-style file scanning, so Phase 2 can reuse that testing pattern with minimal stack expansion.

**Primary recommendation:** Add a shared `externalApiPolicy` + provider adapters that gate real network calls by mode/host, return deterministic provider-shaped mock payloads by default in emulator/local, and backstop with contract tests that ban raw production endpoints outside approved files.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `firebase-functions` | `^6.3.2` | Callable handlers, `HttpsError`, runtime env/params integration | Existing production runtime for all publish paths |
| `firebase-functions/params` | bundled in `firebase-functions@^6.3.2` | Typed runtime config for mode/overrides | Official, current config path in this repo (`notificationParams.ts`) |
| `axios` | `^1.6.5` | External HTTP transport to Subsplash/SoundCloud | Already used in all provider clients |
| Node `URL` + `crypto` | Node `22` builtin | Host allow/deny checks and deterministic ID hashing | No extra dependency required |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `jest` + `ts-jest` | `^29.7.0` / `^29.4.0` | Unit/contract tests for policy and mocks | Required for DEVSAFE regression gates |
| `nock` | latest 14.x | Hard-disable unexpected outbound network in tests (`disableNetConnect`) | Optional but recommended for stronger runtime leak detection |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Adapter-level policy module (selected) | Scatter checks in each callable | Duplicates logic; high regression risk |
| Deterministic hash-based mock IDs (selected) | In-memory counters / `Date.now()` IDs | Non-deterministic across retries/process restarts |
| Source-scan contract test (selected) | ESLint custom rule only | ESLint config complexity is higher; contract test is faster to adopt here |

**Installation:**
```bash
pnpm --filter functions add -D nock
```

## Architecture Patterns

### Recommended Project Structure
```
functions/src/
├── externalApi/
│   ├── externalApiPolicy.ts      # mode parsing + fail-closed checks + host policy
│   ├── policyErrors.ts           # stable error code/details builders
│   ├── providerHosts.ts          # canonical production host constants
│   ├── subsplashMockProvider.ts  # deterministic provider-shaped Subsplash responses
│   └── soundcloudMockProvider.ts # deterministic provider-shaped SoundCloud responses
├── subsplashUtils.ts             # route auth/config through policy gate
├── soundcloudClient.ts           # route track operations through policy gate
└── test/
    ├── externalApi/policy.test.ts
    └── externalApi/endpointGuard.contract.test.ts
```

### Pattern 1: Centralized Fail-Closed Mode Resolver
**What:** Resolve mode once per request boundary using emulator/local detection and explicit override flags.
**When to use:** Before any provider network call (Subsplash/SoundCloud).
**Example:**
```typescript
// Source: https://firebase.google.com/docs/functions/config-env
// Source: repo pattern: functions/src/notifications/notificationParams.ts
export type ExternalApiMode = 'mock' | 'live';

export function resolveExternalApiMode(env: NodeJS.ProcessEnv): ExternalApiMode {
  const isLocalLike = env.FUNCTIONS_EMULATOR === 'true' || !!env.FIREBASE_EMULATOR_HUB;
  const raw = env.EXTERNAL_API_MODE?.trim().toLowerCase();

  if (isLocalLike) {
    if (!raw) return 'mock';
    if (raw !== 'mock' && raw !== 'live') {
      throw new HttpsError('failed-precondition', 'Invalid EXTERNAL_API_MODE. Allowed: mock|live in emulator/local.');
    }
    return raw as ExternalApiMode;
  }

  return raw === 'mock' ? 'mock' : 'live';
}
```

### Pattern 2: Provider Adapter Boundary With Host Enforcement
**What:** All outbound provider URLs pass through host checker before axios dispatch.
**When to use:** `subsplashUtils` and `soundcloudClient` only.
**Example:**
```typescript
// Source: https://axios-http.com/docs/interceptors
const BLOCKED_HOSTS = new Set(['core.subsplash.com', 'api.soundcloud.com']);

export function assertProviderHostAllowed(url: string, mode: ExternalApiMode, allowProd: boolean): void {
  const host = new URL(url).hostname.toLowerCase();
  if (mode === 'mock') {
    throw new HttpsError('failed-precondition', 'Mock mode forbids production provider calls.');
  }
  if (!allowProd && BLOCKED_HOSTS.has(host)) {
    throw new HttpsError('failed-precondition', `Outbound host blocked by policy: ${host}`);
  }
}
```

### Pattern 3: Deterministic Provider-Shaped Mock Builders
**What:** Return realistic response objects with stable IDs from semantic input hash.
**When to use:** Upload/edit/delete flows for both providers in emulator/local default mode.
**Example:**
```typescript
// Source: https://nodejs.org/api/crypto.html
import { createHash } from 'node:crypto';

const stableId = (prefix: string, seed: string) =>
  `${prefix}-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;

export function mockSubsplashUpload(input: { title: string; audioUrl: string; operationKey?: string }) {
  const seed = `${input.operationKey ?? ''}|${input.title}|${input.audioUrl}`;
  const id = stableId('media-item', seed);
  return {
    id,
    title: input.title,
    status: 'published',
    _links: {
      self: { href: `https://core.subsplash.com/media/v1/media-items/${id}` },
    },
  };
}
```

### Anti-Patterns to Avoid
- **Callable-level ad hoc checks:** Do not replicate policy parsing across six publish callables.
- **Non-deterministic mock IDs:** Avoid `Date.now()`/`Math.random()` mock identity for retry-sensitive flows.
- **Silent fallback to live mode:** Missing/invalid mode in emulator/local must throw immediately.
- **Broad egress blocking:** Restrict to Subsplash/SoundCloud production hosts as decided.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Runtime mode config parsing | Multiple bespoke env parsers in each function | One shared `externalApiPolicy` resolver | Prevents drift and contradictory behavior |
| Network dispatch guardrails | Manual string checks scattered in callables | Central host parser (`new URL`) + allow/deny host sets | Correct hostname parsing and maintainable policy surface |
| Regression policing | Manual code review for endpoint literals | Contract test that scans file contents for banned host usage | Deterministic CI gate against regressions |
| Mock payload generation | Per-test ad hoc object stubs | Shared deterministic provider mock builders | Consistent behavior across local runs and tests |

**Key insight:** In this phase, correctness depends more on policy centralization and regression guardrails than on mocking sophistication.

## Common Pitfalls

### Pitfall 1: Hidden Direct Endpoint Calls Outside Adapters
**What goes wrong:** A new file calls `https://core.subsplash.com` or `https://api.soundcloud.com` directly, bypassing mode policy.
**Why it happens:** Existing codebase has many historical hardcoded URLs.
**How to avoid:** Add a contract test that fails if banned host literals appear outside approved boundary files.
**Warning signs:** New direct `axios(...)` in mutation helpers or scrapers without adapter usage.

### Pitfall 2: Local Mode Ambiguity (Fail-Open)
**What goes wrong:** Emulator/dev runs still hit production due to unset/invalid mode.
**Why it happens:** Policy defaults are permissive or inconsistent.
**How to avoid:** In local-like runtimes, missing/invalid mode must default to `mock` or throw `failed-precondition` with remediation text.
**Warning signs:** Local publish succeeds despite no explicit mode config.

### Pitfall 3: Mock Shapes Diverge From Caller Expectations
**What goes wrong:** UI flow breaks because mock responses omit fields used downstream.
**Why it happens:** Minimal placeholder mocks instead of provider-shaped payloads.
**How to avoid:** Base mock schemas on existing real-response usage in callables/tests (`id`, status fields, `_links`, etc.).
**Warning signs:** Type assertions/casts or undefined-field errors in publish/edit/delete flows.

### Pitfall 4: Non-Deterministic Mocks Break Retry/Idempotency Validation
**What goes wrong:** Retry path tests fail intermittently because mock IDs change between attempts.
**Why it happens:** Timestamp/random-based identity generation.
**How to avoid:** Seeded hash IDs derived from semantic input (`operationKey`, entity IDs, request body shape).
**Warning signs:** Snapshot churn and flaky retry assertions.

## Code Examples

Verified patterns from official/repo sources:

### Typed Param Fallback Pattern (already used in repo)
```typescript
// Source: functions/src/notifications/notificationParams.ts
import { defineString } from 'firebase-functions/params';

export const externalApiMode = defineString('EXTERNAL_API_MODE', {
  default: 'mock',
  description: 'mock|live external provider mode for local/emulator safety policy',
});
```

### Endpoint Guard Contract Test Pattern
```typescript
// Source pattern: utils/callableConcurrency.contract.test.ts
import fs from 'fs';
import path from 'path';

const files = [
  'functions/src/uploadToSubsplash.ts',
  'functions/src/editSubsplashSermon.ts',
  'functions/src/deleteFromSubsplash.ts',
  'functions/src/soundcloudClient.ts',
];

for (const rel of files) {
  const text = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
  expect(text).not.toContain('https://core.subsplash.com');
  expect(text).not.toContain('https://api.soundcloud.com');
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct production URLs spread across callables/helpers | Central policy + adapter-controlled provider URLs | Phase 2 target (2026) | Eliminates accidental prod traffic in local/emulator runs |
| Ad hoc test mocks per function | Shared deterministic provider mock contracts | Phase 2 target (2026) | Stable local flow and retry behavior |
| Manual regression detection | Automated contract/source-scan guardrails | Phase 2 target (2026) | Blocks unsafe endpoint reintroduction in CI |

**Deprecated/outdated:**
- Raw production URL literals in publish-path mutation handlers.
- Emulator/local publish behavior that depends on secret presence (`EMAIL`, `PASSWORD`, `SOUNDCLOUD_ACCESS_TOKEN`) instead of explicit mode policy.

## Open Questions

1. **Scope of "production Subsplash hosts" beyond `core.subsplash.com`**
   - What we know: Current publish-path targets mostly `core.subsplash.com`; SoundCloud uses `api.soundcloud.com`.
   - What's unclear: Whether policy should also block other Subsplash production domains used by adjacent flows (for example image endpoints).
   - Recommendation: Start with the explicit publish-path host set in Phase 2; document extension points for future host additions.

2. **Override shape for intentional live calls in dev**
   - What we know: User requires explicit override to allow real provider traffic in dev.
   - What's unclear: Single global flag vs per-provider flags.
   - Recommendation: Use one mode (`EXTERNAL_API_MODE=live`) plus per-provider booleans (`ALLOW_PROD_SUBSPLASH`, `ALLOW_PROD_SOUNDCLOUD`) to minimize accidental broad enablement.

## Sources

### Primary (HIGH confidence)
- https://firebase.google.com/docs/functions/config-env - params/config model (`defineString`, environment handling).
- https://firebase.google.com/docs/emulator-suite/connect_functions - emulator callable routing semantics for local/test execution.
- https://firebase.google.com/docs/functions/local-emulator - local functions emulator behavior and operational constraints.
- https://axios-http.com/docs/interceptors - centralized request policy hooks at HTTP boundary.
- https://nodejs.org/api/crypto.html - deterministic hash generation for stable mock IDs.
- Repository evidence:
  - `functions/src/subsplashUtils.ts`
  - `functions/src/soundcloudClient.ts`
  - `functions/src/uploadToSubsplash.ts`
  - `functions/src/editSubsplashSermon.ts`
  - `functions/src/deleteFromSubsplash.ts`
  - `functions/src/uploadToSoundCloud.ts`
  - `functions/src/editSoundCloudSermon.ts`
  - `functions/src/deleteFromSoundCloud.ts`
  - `functions/src/test/series/mocks.ts`
  - `utils/callableConcurrency.contract.test.ts`

### Secondary (MEDIUM confidence)
- https://github.com/nock/nock#disabling-requests - optional stronger no-network test harness (`disableNetConnect`).

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** - Based on installed dependencies and existing runtime/testing patterns.
- Architecture: **HIGH** - Strong repository evidence for adapter boundaries and callable contracts.
- Pitfalls: **HIGH** - Directly observed historical hardcoded endpoints and current mock patterns.

**Research date:** 2026-03-08
**Valid until:** 2026-04-07
