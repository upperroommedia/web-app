# Durable operations architecture

Status: implementation and verification in progress. Production remains on the legacy owners until the staging cutover is verified.

## Decision

Use single-region Temporal Cloud on GCP `us-central1`, with one application worker VM per environment, for operations whose effects outlive an HTTP request or a browser tab: audio processing, provider publishing and cleanup, remote list/series mutations, image ingestion, search convergence/backfill, account side effects, email delivery, bundle generation and maintenance. Keep authentication, authorized reads, byte transfer, playback, trimming previews, synchronous image serving and CDN caching at their existing boundaries.

Firebase admits an authenticated, validated intent and writes its durable job and dispatch outbox atomically. Workers read that private outbox and communicate with the authenticated, project-bound Temporal Cloud endpoint. Browser clients never receive Temporal credentials or start arbitrary workflows. A lost admission response can be recovered with the same requester-scoped request ID.

Workflow histories contain immutable identifiers, bounded safe outcomes and generation references. Activities load business payloads from private Firestore intents and provider credentials from runtime secrets. Invitation tokens, rendered email, provider diagnostics, cookies, signed URLs and media bytes must not enter history or public job records.

## Ownership and concurrency

Each resource has a generation within an operation scope. Processing audio and publishing a sermon have distinct scopes; two operations that mutate the same remote resource still share the established resource locks. Admission rejects unsafe competing requests rather than changing ownership while an uncertain provider effect is unresolved. Every activity rechecks the desired generation and the actor's current authorization before effects, and fences final writes.

A Temporal workflow ID prevents duplicate executions; it does not make an external provider's POST idempotent. Provider receipts are persisted before effects. A confirmed remote ID is reused. An interrupted POST with no authoritative result enters operator review. Operators can adopt a result only after domain-specific verification; ambiguous effects must never be reset and blindly repeated. SMTP acceptance has the same uncertainty boundary and cannot be advertised as exactly once.

The outbox dispatcher uses leases and stable dispatch IDs. Losing an acknowledgement after starting a workflow is resolved by Temporal execution identity. Entity coordinator signals must additionally deduplicate the dispatch/job ID so repeated delivery does not recreate effects. Expired leases are recoverable. Dispatcher errors and retry decisions are stored as bounded codes, not raw provider errors.

## User-visible state

The server owns `durableJobs`, with monotonic projection revisions, named steps, measured progress, confirmed destination outcomes and explicit available actions. The UI uses an authenticated shared subscription registry and entity active-job references. Cached or disconnected views are marked stale. A cancelled request is not displayed as cancelled until active effects have stopped and cleanup/reconciliation is complete.

A file upload starts with an `awaiting_source` receipt and an immutable server-selected source path. The browser transfers bytes, then confirms the exact storage generation. The server validates ownership, metadata, size and source fingerprint before admitting processing. The upload receipt links to the processing job. Closing a tab before transfer completion requires reselecting the same file; closing it after source confirmation does not interrupt server processing. The UI must not report admission as processing success or delete a source following an ambiguous response.

## Runtime and deployment

All Temporal TypeScript packages are aligned at 1.24.0. Native audio activities run on a Debian/glibc Node 22 image with cancellable child processes. Production workflows are prebundled; the workflow sandbox has no provider, Firebase or filesystem imports. Workers use deployment versions and pinned workflow executions, with old image digests retained until those executions drain. Replay verification is required before a compatible worker change is released.

Staging and production use separate project-bound Cloud namespaces in GCP `us-central1` and one worker VM per environment. This selected deployment has no self-hosted Temporal/PostgreSQL service, cross-region replica, database restore drill or PITR prerequisite. A worker-server outage pauses processing until that server returns; Temporal Cloud retains workflow history. Actual identity/access checks, bounded host capacity, original-run worker restart verification and drain-aware releases remain required. Follow the [Cloud single-VM deployment guide](../../ops/temporal/CLOUD.md). The [self-hosted operations guide](OPERATIONS.md) describes an optional fallback and does not govern this selected hosting path.

## Cutover and rollback

The migration preserves a single owner per domain and resource. Before enabling a Temporal domain, stop new legacy admissions, drain Cloud Tasks and in-flight provider operations, inspect unresolved leases/receipts, then deploy compatible admission, workers and UI together. Explicit environment flags control ownership; a worker outage must leave durable jobs queued rather than invoke a second legacy owner.

Validate staging failure injection, reconnect/reload, cancellation, lost acknowledgements, provider receipt adoption and worker restart before enabling production. Merge to staging for the owner's smoke test. Promote to main only after approval. Rollback must preserve jobs, receipts and intents, retain the worker version needed by running workflows and stop new admissions before moving ownership.

## Documentation basis

- [Temporal production deployment](https://docs.temporal.io/production-deployment)
- [Self-hosted service guide](https://docs.temporal.io/self-hosted-guide)
- [Worker deployment and performance](https://docs.temporal.io/best-practices/worker)
- [TypeScript SDK guide](https://docs.temporal.io/develop/typescript)
- [Official AI developer plugin](https://github.com/temporalio/codex-temporal-plugin)

Domain implementation notes describe the exact adapters, receipts and boundary cases. This decision is not a claim that deployment or cutover has completed.
