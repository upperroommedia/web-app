# Staging provider sandbox

Staging runs the real authenticated admission, Firebase records, Temporal workflows, worker activities, retries, task history and recovery controls. Subsplash and SoundCloud operations use a persistent virtual provider inside the staging Firebase project. This is a publishing sandbox, not evidence that the real vendors accepted or played anything.

The authoritative initialized Admin application must be `urm-app-staging`, and the server must explicitly set `STAGING_PROVIDER_MODE=sandbox`. Production rejects this setting. Neither a browser flag nor a request payload selects the backend. Missing configuration, an unready catalog, an unknown endpoint or a mismatched profile fails closed. There is no fallback to a vendor URL, production credential, token refresh or live provider relay.

The fixed profile is `urm-app-staging-publishing-v1`, version 1. Private state lives under `_providerSandbox/urm-app-staging-publishing-v1`: its root document is the catalog readiness marker; subcollections contain virtual resources, immutable requests, scoped fault plans and catalog import audits. Resources are keyed by SHA256 of `[provider,family,id]`. Existing canonical IDs are opaque aliases within this namespace. The historical Subsplash `app:9XTSHD` value is a compatibility symbol here, not proof of access to that real account. The virtual SoundCloud account is `9000000000001`; imported track URNs use numeric resource keys while retaining their URN in virtual metadata.

## Existing catalog and media provenance

The catalog planner reads staging sermons, lists, series, speakers, images and membership mirrors. It preserves all canonical IDs, historical intents, receipts, provider-usage epochs and release history. It never reads a real provider to fill missing data. Published relationships must resolve from the staging snapshot or planning fails.

Imported virtual audio uses an explicitly reviewed staging-owned fixture, pinned by exact bucket, object path, generation, size, content type and SHA256. The fixture must be inside `_providerSandbox/PROFILE/`; the operator verifies its actual bytes. Fresh fixtures currently support bounded-header PCM RIFF/WAVE audio only: the importer measures duration from validated format/data lengths in the same pinned generation, rather than trusting custom duration metadata. Import provenance is `staging-canonical-aliases-with-reviewed-simulation-audio`. It does not claim a copy of the original vendor audio. New uploads and publishing operations use their own real staging Storage assets; a successful catalog import does not prove that end-user upload path.

## Activation and operator commands

Complete the existing release first. Start a new reviewed release and apply the effective global admission pause before importing or enabling this profile. Do not reuse the legacy provider backfill, change its epoch, rewrite old receipts or bypass search's predecessor continuity checks. The provider-usage index is logical reference accounting; the separate sandbox marker proves only a virtual catalog import.

Every pre-profile nonterminal provider-affecting job must finish or receive an explicit reviewed disposition before activation. Import rejects active publishing, image and potentially provider-bearing speaker jobs. It never resets or silently resumes them in a different provider environment.

Prepare a JSON fixture reference containing `bucket`, `path`, `generation`, reviewed `sha256`, `size` and measured `durationSeconds`. Use the committed candidate operator with the same reviewed release descriptor and exact control revision:

```sh
STAGING_PROVIDER_MODE=sandbox node scripts/temporal-import-provider-sandbox.mjs \
  --inspect --release /private/release.json --revision REVISION \
  --fixture /private/fixture-reference.json --output /private/catalog-plan.json
```

Review the source count/digest, virtual resource count/digest, exact aliases, fixture evidence, operator identity and live staging resource binding. Inspection performs no catalog writes. Then apply that exact plan with a fresh explicit operation UUID and output path:

```sh
STAGING_PROVIDER_MODE=sandbox node scripts/temporal-import-provider-sandbox.mjs \
  --apply --release /private/release.json --revision REVISION \
  --plan /private/catalog-plan.json --operation-id UUID \
  --output /private/catalog-import-result.json
```

The importer acquires the normal nonexpiring release-operation lock. It requires effective global pause, structurally valid states for all seven domains, zero active provider jobs and zero unresolved legacy admission leases. Search-only freezes retain the first six per-domain flags; the global admission gate still blocks new work, so the importer does not rewrite those flags. It checks the same globally paused native control/checkpoint snapshots during every bounded page, writes only private virtual resources, and atomically commits an immutable audit and ready marker after rechecking the full canonical snapshot and resource set. Canonical data and release phase are unchanged. A partial failure before final commit retains its owned operation and building marker: inspect them and explicitly resume the same reviewed plan and UUID. If the final commit acknowledgement is lost, inspect the actual ready marker and immutable audit; an absent operation is not permission to start another import. Never delete the lock, overwrite existing engine state, substitute a new plan or infer completion from elapsed time. Firestore transactions and Storage fixture observations are separate operations; no cross-service atomicity is claimed.

After import, verify the exact ready marker and run the provider transport/readiness preflight before opening admissions. Deploy and verify staging mail capture as well: publish failures and account flows must not send real SMTP mail. Keep the original release/cutoff history intact and follow the new release's normal backend, UI and smoke gates.

## Scenarios and task history

New server-admitted provider jobs pin their profile/version and scenario in the immutable private intent and public `durableJob.providerExecution` projection. Ordinary jobs default to `success`. Only an authenticated staging administrator can supply `payload.providerSimulationScenario`:

- `success`: normal provider responses and state transitions.
- `delayed-processing`: accepted media remains processing before becoming ready.
- `transient-failure`: a scoped provider operation fails before its side effect.
- `permanent-failure`: a scoped operation returns a terminal provider rejection.
- `commit-then-lost-response`: the virtual mutation commits, but the caller loses its acknowledgement.

Faults are persisted and consumed within a server-owned job/step scope. Retrying the same intent retains its original scenario; a client cannot change it through a retry command. A lost response must exercise the real uncertain-effect review/recovery path, not automatically duplicate a creation. Historical canonical publication labels are not relabelled as simulated merely because today's global mode is sandbox.

## Human verification

Before calling staging ready, verify a fresh upload and publish to both destinations, delayed readiness, a recoverable failure, an uncertain creation with explicit recovery, metadata edits, list/series ordering, unpublish/delete and worker restart while a task is active. Confirm one virtual resource per acknowledged allocation, durable public progress after refresh, immutable request evidence, and zero vendor/production/SMTP side effects. An inspector proves virtual state and request evidence; it cannot prove real Subsplash/SoundCloud compatibility, remote encoding or production delivery. Record actual outcomes and leave unrun checks pending.
