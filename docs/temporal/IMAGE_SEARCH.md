# Image and search durable execution

Images upload immutable source objects before admission. The server checks ownerUID, requestId, exact Storage generation, MIME type, size, and canonical destination IDs. Workflow history contains only job/project references. Private receipts retain destination allocation and signed PUT URLs. A failed or timed-out allocation is never repeated blindly: the job requires operator reconciliation. Only a destination allocated by this exact immutable source claim permits retries of PUT; an operator-selected existing resource is never overwritten; successful image publication occurs only after byte transfer succeeds. Temporary files are unique to one attempt and always removed.

The shared metadata helper decodes images with Sharp before invoking any secondary colour parser, including dimension-only checks. It limits input to 40 million pixels and 16,384 pixels per side, preserves reported source dimensions, and supplies only a newly encoded PNG of at most 128 pixels per side to average-colour and palette extraction. Malformed inputs fail before provider upload and are not retried as transient image failures. This bounds palette work and prevents original uploaded bytes from reaching the affected transitive [file-type ASF parser](https://github.com/advisories/GHSA-5v7r-6r5c-r473); the dependency advisory remains visible until the upstream CommonJS image dependency is replaced or patched.

The image source object generation is pinned for reads/deletes. Deletion derives provider identity from canonical images. Shared Subsplash images are retained until an administrator records deliberate retention, or an authenticated read proves the fixed image ID was already removed under its sealed original account. This service never issues DELETE against a shared provider image. Generation-pinned local storage and canonical cleanup finish after that disposition is recorded. Existing legacy image records require explicit generation reconciliation before durable deletion. Synchronous resizing/CDN requests stay outside Temporal.

Search uses separate `urm-search` worker concurrency. Each document takes the existing `_algoliaSyncLocks` lease, reads current Firestore truth instead of stale event contents, retains both pending and last confirmed alternate objectIDs, waits for Algolia tasks, and reads Firestore again before declaring convergence. Changed/deleted alternate IDs are removed before saving the current record. Provider errors are sanitized before entering workflow history. The bounded activity budget fits inside the shared legacy lease.

Full indexing pages 25 source documents at a time, uses deterministic per-page/document admission IDs, waits for all admitted jobs to succeed, and carries a cursor/count through ContinueAsNew after 100 pages. A source failure blocks successful backfill completion. Collection-group cursors use document paths. Backfills coexist with live traffic through the same document locks and authoritative reads.

## Cutover

Keep `TASK_ORCHESTRATOR_SEARCH=legacy` until the dispatcher, matching worker config/secrets and namespace are ready. Drain Cloud Tasks full-index pages and in-flight legacy leases before changing the deployed kit to `temporal`. The kit's trigger then creates durable jobs/outbox instead of calling Algolia. Never enable both execution owners intentionally. Runtime search configurations are server-owned and keyed by existing FIREBASE_KIT_INSTANCE_ID; the worker receives API keys privately. No key or record body belongs in jobs or history.

Source image finalize admission and durable canonical commit use the common server bridge. Before activating image ownership, reconcile existing sources/receipts and ensure canonical generation fences are checked atomically with publication. An ambiguous ingest cannot be adopted by title, dimensions, MIME type, or a selected ID. Existing provider bytes cannot be proven identical through this API. Review retains the selected resource without PUT; the user starts a separate upload for new bytes.

## Legacy image generation reconciliation

Run `node scripts/reconcile-legacy-image-generations.mjs --project PROJECT --bucket IMAGES_BUCKET` for a read-only report. Add `--apply` only after reviewing that report. The script pins the current generation only when it predates canonical publication and the canonical download token still matches. It refuses newer replacements, missing timestamps, foreign buckets and unverified sources. Each 100-record page prints a resume checkpoint usable with `--after IMAGE_ID`. Apply checks the canonical document's original update timestamp in the write transaction, so concurrent edits cannot be overwritten.

## Superseded allocation cleanup

A superseded ingest preserves its private provider receipt and admits a separate `ImageReceiptReconciliation` job with independent entity scope. Confirmed allocated IDs remain protected even when this project has no canonical references; immutable source bytes remain intact. Unknown allocations create an administrator review state. The review offers deliberate retention or original-account fixed-ID absence verification, records evidence/reason, and atomically commits the reviewed receipt together with the owning command. Risk acknowledgment never permits deletion. Retention creates a sealed permanent provider-use edge which protects the resource across canonical cleanup and usage-index rebuilds. It does not prove the original create request succeeded or failed. Private audits retain the possible unknown-original risk.

## Deletion consistency after permission changes

Image deletion records confirmed remote and generation-pinned Storage acknowledgments separately in a private receipt bound to the immutable deletion identity. A retry never repeats a confirmed remote absence check, and no current image workflow deletes a shared Subsplash resource. Once both destinations are confirmed absent, canonical finalization uses only the current generation and exact canonical source/provider identity fences: this completes consistency for already finished effects and grants the original actor no further provider access.

If permission changes after only one destination completes, the remaining effect pauses. A freshly authorized administrator may approve a continuation bound to that receipt, job generation, and command. The grant is committed atomically with the resume/cancel command and the administrator's current role is checked again before the remaining effect. An unstarted deletion cannot receive such a grant. The private `temporalImageCleanupAuthorizations` collection is inaccessible to clients.

## Independent control queue

Search page confirmations, terminal projections, and image terminal projections run on `urm-controls`, separate from provider and native media activities. Cancellation waits for provider activities to abort and drain before cleanup; confirmed receipts remain available if a cleanup needs a later administrator continuation.

## Release ownership

Temporal search admissions read `_control/temporalRelease` inside the admission transaction and fail closed without a valid open Temporal owner. Duplicate accepted events remain recoverable during a pause. Legacy search lock claims and image provider ingress check the same owner, so a stale deployment flag cannot accidentally restart the previous provider execution path after cutover.

The provider account marker stays in private allocation/deletion receipts. It binds the configured principal and app only for authenticated fixed-ID absence checks; it is not proof of app-wide association absence. Legacy images without that binding offer retention only. No provider principal, token, signed URL, or account marker is written into canonical images, public jobs, search records, or workflow history.

## Late image allocation acknowledgements

The authenticated allocation response is persisted first in the immutable private `temporalImageAllocationAcknowledgements` journal, independently of release ownership, provider-index readiness, or child admission. Its stable identity uses project ID, job ID, allocation claim nonce, and remote ID. A late response never replaces an operator-selected retained resource or uploads bytes into it. A distinct original resource creates a separate reconciliation job and temporary provider-use binding through a retrying journal trigger. The ingest remains in attention while any already-known additional resource is unresolved.

Retention does not erase the original unknown-create fact. When no original response arrives, that uncertainty remains disclosed in the terminal projection and private audit. When one arrives later, the immutable journal records it and routes the resource to review. The temporary binding is released only together with sealed original-account fixed-ID absence proof or a reviewed permanent retention binding; index rebuilds restore unresolved bindings and do not resurrect already-proven absent resources.
