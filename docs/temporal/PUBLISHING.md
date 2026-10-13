# Durable publishing

Publishing consists of distinct provider steps. Each step loads the authorized,
immutable payload through a private job reference. Workflow history receives only
the job reference, sermon identity, generation, destination selection and state
codes. Signed media URLs, descriptions, authorization tokens and raw provider
responses remain outside history.

The publish workflow runs SoundCloud independently. Subsplash preparation, list
membership and series membership run in that order because list and series
mutations share the same media resource. Local completion follows all requested
destination work. Closing a browser does not cancel admitted work. A failed
destination retains completed receipts and can resume after reconciliation.

## Provider creation and ambiguity

A creation receipt is written before a non-idempotent provider request. A confirmed
receipt permanently records its result under an immutable payload fingerprint.
Retrying the same intent reuses that result. Reusing an operation key with a changed
payload is rejected. A process crash or network failure after a request might mean
the provider accepted the request. Such a receipt requires operator review; a
retry does not issue another POST. Matching a title or date is insufficient proof
that an existing provider resource belongs to an intent. An authorized operator
may intentionally adopt a compatible existing resource after acknowledging the
duplicate risk and recording evidence and a reason. This is audited reassociation,
not proof that the original request succeeded. Possible original duplicates remain
an operator cleanup concern; absence resets are rejected.

Provider mutation requests run once with redirects and automatic mutation retries
disabled. Reads may use bounded retries. Mutable updates require an original
synchronous HTTP 200 or 204 response; HTTP 202 acceptance does not establish
completion. A positive original response permits factual canonical completion; an uncertain response enters review without reissuing
the request. Current-state GET comparisons cannot prove that an earlier request
finished. Destructive drift resolution remains a user choice.

## Resource ownership and coexistence

Existing Firestore list, series and media-item leases remain authoritative while
legacy writers exist. A Temporal workflow ID deduplicates one intent; it does not
serialize different intents that share a resource. Activities declare the complete canonical resource graph before provider mutation
and atomically acquire an exclusive, non-expiring session. The graph is checked
again before effects. Renewable compatibility locks provide fairness, while the
persistent session holds ownership through the original provider acknowledgement
and the final canonical transaction. Unknown requests retain ownership during
worker restarts, retries, OAuth reconnection, and operator review; neither a lease
timeout nor a matching GET releases them. Revision and execution checks prevent
obsolete work from overwriting newer desired state.

Every request fingerprint includes its exact provider target, method and body.
A list row or a newly created overflow list requires a server-derived ownership
proof tied to a leased root. A client-supplied parent is insufficient. The original
proof is retained for confirmed-response recovery after the row has been removed.
Unchanged list members do not each consume a mutation lock; their association
references remain protected by the provider usage index.

Before a mutable request, the worker freezes its allowed factual tracking writes.
An administrator can repair a known original acknowledgement using that immutable
program and fresh provider verification, without issuing the mutation again.
Uncertain responses cannot use this path. A graph change detected before effects
aborts the unused session permanently; the caller must submit a fresh intent.

Deleting a sermon removes provider content before deleting its local canonical
record. Partial external cleanup remains visible and resumable. Cancellation must
not infer that an in-flight provider POST failed, or remove content that existed
before the workflow.

## Operational control

The worker exposes `publishingResume` and a `publishingStatus` query. Resume is sent
only after authenticated control actions reconcile an ambiguous receipt or repair
authorization. The frontend subscribes to job projections for durable state; it
does not own provider IDs or completion writes. Never expose the self-hosted
Temporal control plane to browser clients.

Reference: [Temporal TypeScript development](https://docs.temporal.io/develop/typescript),
[activity failure detection](https://docs.temporal.io/develop/typescript/failure-detection),
[workflow message passing](https://docs.temporal.io/develop/typescript/message-passing).

## Domain coverage and update dependencies

`publishingEntityWorkflow` handles canonical list, series and speaker commands.
Admission replaces submitted provider IDs and media URLs with canonical references.
Maintenance uses fixed page manifests and per-item checkpoints; bounded histories
continue as new without marking the job failed. Imported records have deterministic
provider-derived identities to prevent duplication during recovery.

Canonical writes use a Firestore transaction that reads the desired generation and
writes the domain projection in the same commit. Existing domain transactions and
batches inherit this fence through trusted worker context. Browser-supplied operation
keys cannot activate that context. Legacy callers retain their existing whole-call
idempotency behavior; workers use per-provider receipts and current-state checks.

An update that requires audio processing admits an audio dependency and awaits its
bounded child workflow before updating provider metadata or finishing the desired
patch. Processing retains ownership in the per-sermon media coordinator. Provider
activities wait for cancellation to settle before lifecycle cancellation is projected;
requesting cancellation never establishes that an external create did not occur.

## Playability, edited audio and deletion

Subsplash media is created as a draft. A private activity checks uploaded audio
output metadata and a bounded range GET before publication or membership mutation.
Only after playable output exists does production apply the fixed-ID publication
PATCH. Staging retains draft behavior. The provider download endpoint returns 405
for HEAD; the implementation uses GET and strips authorization on CDN redirects.
Transcoder allocation or an accepted job is insufficient proof of readiness.

SoundCloud readiness requires a streamable track and documented full HLS outputs.
An audio edit cannot replace an existing SoundCloud file through the public API.
When an existing track is affected, admission requires an explicit policy:
`recreate_track` creates a replacement, preserves privacy/rights settings and waits
for playable streams before atomically changing the canonical track reference.
Only then is the old track deleted. The new track has a new link and engagement
history. `keep_existing_audio` intentionally retains SoundCloud's existing audio.
Subsplash replacements retain the existing media identity and memberships, create
new audio and transcode receipts, wait for playable output, and verify the binding
before committing it. The old audio binding remains available for recovery.

Readiness polling uses durable timers, a bounded hour of encoding checks and five
transient retries. Exhaustion becomes an explicit attention state requiring an
authorized resume; provider creation ambiguity never becomes an automatic retry.

Deletion first closes media admission for the sermon and drains the actual media
coordinator and native operations. It then marks destructive effects, removes
provider content, releases canonical artifact references and deletes the canonical
sermon. Cancellation clears the media admission tombstone only if destructive
provider work has not begun. Immutable audio is retained for at least 90 days after
its final reference release rather than deleted as a prefix while providers may
still fetch it.

Every publishing source is leased before bytes or a URL reaches a provider. Scoped
receipts retain leases while a create result is unknown. Subsplash transcode jobs
must be terminal before a source lease can be released; an allocation receipt is
not enough. Public legacy mutations acquire durable admission leases, so release
control can pause new work and prove all admitted writers have settled before
ownership changes. Lease expiry does not establish that an external effect ended.

Provider references: [SoundCloud API guide](https://developers.soundcloud.com/docs/api/guide),
[SoundCloud OpenAPI](https://developers.soundcloud.com/docs/api/explorer/open-api).
The Subsplash output and transcode status checks additionally follow the existing
provider integration and verified read-only schema and playback responses.

Sermon metadata edits also carry one canonical membership selection. Admission
snapshots the previous local and published memberships and validates the draft
revision before queuing work. Removed published lists are unlinked before their
local mirrors are deleted. New list selections remain drafts. A previously
published series membership moves by removing the old membership, verifying the
media is playable, and adding the new membership. The final generation-fenced
transaction commits the selected local mirrors, stable series positions and edited
metadata together. Metadata-only edits preserve omitted selections.

Speaker approval uses the same provider primitives as publishing. Its operation
key includes the Firebase project and durable account job ID, and all speaker/list
canonical writes inherit the account generation fence. A lost create response
projects the safe receipt reference and waits for reviewed resolution. Intentional
resource adoption commits the receipt, audit and `accountResume` outbox command in
one authorized transaction; merely resuming cannot issue a second ambiguous POST.

An Activity timeout or worker interruption is also a recovery boundary. The
workflow reads the qualified private receipt index before deciding what follows.
An executing or uncertain create enters review without repeating the request;
confirmed or safely prepared stages can resume under the original job and operation
key. Missing receipt evidence blocks recovery. The workflow remains available for
authenticated resolution rather than turning an unknown provider outcome into a
fresh create job. Native tests cover Activity failure, review, resume and history
replay in addition to ordinary domain responses.

Cancellation stays live while any external result is unknown. Reviewed resolution
signals a cleanup-only continuation; it cannot restart the requested publish/edit.
Confirmed allocations are deleted only after the resource reference index reserves
an unreferenced identity, and a fresh provider GET confirms absence. Resources
intentionally adopted during review remain protected. A missing or building index
keeps cancellation waiting automatically until the paused, drained backfill proves
references; it does not impose a fleet-size limit.

Association requests reserve the exact provider resources before the HTTP effect.
Their private per-job binding ledger records the target receipt or fixed remote
association. Unknown requests retain these edges. Successful canonical projection
releases guards only when the same resource is protected by a live canonical edge,
verified in the same fenced transaction. Remote-only audio bindings require actual
association-removal or terminal-fetch proof. The index backfill and release gates
are described in `docs/TEMPORAL_PROVIDER_USAGE.md`.

A positive provider acknowledgement is a private fact even when the actor loses
permission immediately afterward. Before the request, generation, actor and
execution claims remain mandatory. Afterward, exact attempt-owner and receipt CAS
checks record the acknowledged allocation without granting canonical write
permission. If review has changed the receipt, an immutable bounded-ID orphan
acknowledgement preserves the original fact without overwriting the reviewed
result. Administrative cleanup requires separately admitted, audited authority;
original-actor revocation does not authorize new desired provider effects.

Long cancellation proof waits continue as new after 200 cleanup checks, carrying
an explicit cleanup-only continuation. The continued run validates the persisted
cancellation intent and execution fence before cleanup. It skips plan loading and
all desired provider mutations, retains protected source leases across the
continuation, and reports cancellation only after proof and cleanup finish.

Shared sermon/provider allocation ownership also persists beyond the renewable
provider lock. A list job and a sermon job cannot create separate provider media
for the same sermon after a worker crash or lock expiry: the second job waits on
the original qualified allocation owner. The owner is released only by an atomic
confirmed canonical association or completed reviewed cancellation proof. Explicit
delete/unpublish retires the shared identity only after fresh fixed-ID absence
proof, and confirmed SoundCloud replacements advance it with the canonical pointer.

Allocation admission pins the canonical content revision, content fingerprint, and
immutable audio source fingerprint. The original provider acknowledgement remains
private evidence if that source changes before canonical association; it cannot
silently attach stale metadata. Metadata completion also records the exact provider
identities it synchronized, including absent destinations. Final local edits check
that snapshot and both allocation owners in the same transaction, so a provider
created by a concurrent list job cannot escape the metadata update.

Original effect descriptors and acknowledged projection manifests record the actual
parent SDK step identities from the trusted execution context. Critical repair
uses source-certified step authority to fence prior canonical writers; browser
labels cannot select the step heads. Positive original HTTP acknowledgement facts
remain factual evidence even when permission or execution ownership changes.

Publishing enters a server-enforced critical phase before irreversible deletion,
publication, or association changes. Cancellation races are decided atomically
before the effect; a browser cannot cancel an already committed critical phase.
Provider effect plans and deletion journals retain fixed identities for recovery.
Every sermon deletion, including a local-only draft, captures its immutable root
and all mirror rows in private pages before the critical phase or artifact
release. Confirmed provider deletions and authenticated fixed-ID absence close
further transport admission while retaining resource ownership. The canonical
root is removed only after that proof; bounded mirror cleanup recomputes counters
from existing rows. A source-proved continuation can finish those fixed pages
after root removal, but cannot create resources or send new provider mutations.
Only completed canonical cleanup and reference settlement release the session.
An administrator can stop the remaining desired work through a separately audited
critical repair certificate. Its workflow signal drains the original execution and
runs only the certificate's fixed reads, factual canonical repairs, and expressly
approved fixed cleanup. It never replays the original desired mutation or creates
new assets. Remaining unknown allocations and acknowledgements still pass through
the live cancellation review barrier before the job may close.

A stopped deletion is reported as stopped, not as a successful deletion. A
source-certified zero-effect stop preserves the sermon, memberships, provider
identities, and audio references, and retires only the original unused deletion
reservation and its owned planning tombstone. A partial stop applies only
independently confirmed changes and keeps remaining content. Both require the
original source program to be sealed against new requests. An unknown original
request continues to hold its resource ownership and cannot become a stopped
result merely because a later read matches the intended state. A fresh authorized
intent is required to perform any remaining desired work.

A SoundCloud audio replacement checks that the authenticated account owns the old
track before allocating a replacement. It preserves private sharing and explicit
non-streaming rights, waits for encoded output, commits the new canonical identity,
and confirms cleanup of the old fixed identity. The chosen keep-existing policy
is recorded explicitly when the user elects to retain the old audio.

Staging currently shares production provider identities. Both worker admission and
actual provider write transports reject staging effects until authoritative account
isolation is implemented. Private emulator simulation can exercise journals and
projections but cannot authorize a live vendor request.

The [official Subsplash OpenAPI reference](https://developer.subsplash.com/api/openapi.yaml)
documents media deletion with a synchronous 204 response. It does not specify
that list rows, series membership, or their counters cascade with that deletion.
A fixed media absence proof therefore cannot substitute for explicit destination
membership cleanup and fresh destination observations before removing tracking.
