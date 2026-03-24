# Phase 2: Dev External API Mocking - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Guarantee local dev and emulator publishing/testing flows do not send production traffic to Subsplash or SoundCloud by default, while preserving usable deterministic mock behavior and fail-closed policy enforcement when configuration is invalid or unsafe.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<specifics>
## Specific Ideas

- Explicit preference: keep default mocked provider behavior in dev, but allow intentional production provider testing behind explicit override flags.
- Deterministic behavior is prioritized for repeated local testing and retry validation.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `functions/src/subsplashUtils.ts`: current Subsplash auth/config builder and production host usage points (`core.subsplash.com`) to route through policy/mode enforcement.
- `functions/src/soundcloudClient.ts`: centralized SoundCloud host client (`api.soundcloud.com`) suitable for policy-aware adapter boundary.
- `utils/createFunction.ts`: frontend callable routing already differentiates local vs production function URL selection and can remain the invocation surface while backend policy enforces external provider safety.
- Existing test mocks (`functions/src/test/soundcloud/mocks.ts`, `functions/src/test/series/mocks.ts`, subsplash locking tests) provide patterns for deterministic provider stubbing in Jest.

### Established Patterns
- Callable entrypoints use `HttpsError` and shared `handleError` normalization; policy failures can align to existing structured error handling.
- Emulator-aware branching already exists in codebase (`process.env.FUNCTIONS_EMULATOR` checks in task generator flows), so phase 2 can follow existing env-gating style.
- Tests already run against emulator-first setup (`functions/src/test/setup.ts`) and use deterministic mock modules for external dependencies.

### Integration Points
- High-risk callables include `uploadToSubsplash`, `editSubsplashSermon`, `deleteFromSubsplash`, `uploadToSoundCloud`, `editSoundCloudSermon`, and `deleteFromSoundCloud`.
- Local admin publish UX entrypoint is `components/ManagePublishingPopup.tsx`, which already funnels provider operations through callable wrappers and will consume policy errors from callable responses.
- Requirements guardrails map directly to `.planning/REQUIREMENTS.md` `DEVSAFE-01..04`, enabling dedicated regression checks tied to this phase.

</code_context>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 02-dev-external-api-mocking*
*Context gathered: 2026-03-07*
