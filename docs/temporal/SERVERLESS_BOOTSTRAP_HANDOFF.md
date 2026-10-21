# Serverless bootstrap and process recovery boundary

The guarded controller now has all six role-specific **bootstrap and stop cycles** in
source. It joins the owned zero-pool/account/grant receipts, starts desired manual
count one, observes the exact native non-current role queues, then stops the same
owned pool under the original parent. Observation failure also enters owned stop;
uncertain authority, protected work or an unknown result retains the fence.
The source also connects a kept-running role-specific activation and a separate stop of
that exact unused activation. None of these operations has been applied to Cloud Run.
Controls, search, email and images guarded native promotions are connected in
source. Media is hard-stopped pending actual capacity proof; orchestration remains
unimplemented. No promotion has been applied to staging.

The final native role-readiness collector still requires candidate versions current,
with no ramp, on the real role queues. The cycle cannot replace that collector.

## Native local evidence

The existing integration CI includes two additional real SDK tests:

- `worker-process-recovery.test.ts` starts the existing no-provider
  `WorkerRestartProbe` on an explicitly pinned version in a real child process.
  It verifies native registration before the sole START, kills that owned process
  with SIGKILL, confirms group absence, and starts a distinct process on the same
  version. The same original RunId answers the waiting query, completes after the
  release signal, and replays. Native history contains both worker identities,
  one execution start and no Activities, children or continuation.
- `noncurrent-bootstrap-routing.test.ts` queues an unversioned Activity before a
  candidate poller registers and another afterward. During the finite two-second
  candidate-only observation neither starts; a legacy unversioned poller then
  completes both. An explicitly pinned workflow and Activity do execute on the
  non-current candidate. No current-version mutation occurs in this test.

The serial release-recovery CI also runs
`scripts/integration/temporal-controls-bootstrap.native.mjs`: actual local SDK
old pinned waiting-run inventory, non-current controls/search/email/images/media Activity and orchestration Workflow/Activity registration,
provider-lock preservation, and explicit candidate-run denial against the dedicated
Firestore emulator. Controlled Cloud API tests cover the scale/stop protocol;
the actual Firestore checkpoint regression checks paused authority, immutable
activation-before-observer, and post-attempt stage rollback denial.

These observations apply to the tested local Temporal CLI 1.9.1 / Server 1.32.0 /
TypeScript SDK 1.24.0 configuration. They do not establish general no-work isolation,
Cloud Run process replacement, native cloud delivery, effective IAM or readiness.
In particular, non-current is not a fence against explicitly routed tasks.

The serial integration suite also includes `shared-deployment-handoff.test.ts`.
It makes an old shared deployment current on a Workflow queue and a controls
Activity queue, then registers independent controls and orchestration candidates.
It promotes controls first and observes the **actual Activity queue's** native
`versioningInfo` and poller deployment options, while the shared deployment remains
on its old version. Only then does it promote orchestration in the shared
deployment, with the server's missing-queue and no-poller guards left enabled.
Both mutations use native deployment conflict tokens. Reusing the original
controls token is rejected with `FAILED_PRECONDITION` (code 9).

An exact original pinned run waits across both mutations, completes Workflow
Tasks on the old shared identity/version, and executes its later Activity on the
old controls worker. Its original RunId and one execution start are preserved.
A fresh execution uses current orchestration and the independent controls worker.
The original history before/after handoff and fresh completed history replay
against the test-only source bundle. This does not test production workflow
compatibility or immutable image bytes. No workers are retired by the fixture.

The fixture uses a separate mutation connection with explicit `interceptors: []`
and `grpc.enable_retries: 0`: the installed SDK's default connection otherwise
adds retry interceptors. A future guarded promotion must preserve that distinction
and persist its exact request/token before its single mutation RPC. Queue routing
observations and a deployment conflict token do not establish an atomic lock over
another deployment's queue ownership. Recheck actual queue routing, original
history heads, pending attempts, provider leases and paused authority immediately
before mutation; unknown acknowledgement permits readback only, never resend,
rollback, retirement or a causal success claim. The canonical production
promotion operation is described below; this fixture does not execute it against
staging.

## Connected controls promotion

`promote-cloud-run-controls` is a separate canonical controller action in the
still-paused `provider-usage-ready` phase. It requires the same thirteen distinct
owned preparation, bootstrap-cycle and retained-activation receipts as unused
controls stop. The controller verifies the source/CI/image evidence and rederives
the full original receipt chain, live pool identity/desired-one configuration,
account identities, scoped grants and secret metadata. The operation never scales
the pool and cannot promote another role.

The native precondition requires exact controls-only Activity registration,
candidate pollers, the real `urm-controls` queue routed to the old shared
deployment, no ramp and no compute association anywhere in the namespace. Two
stable scans require paused original authority, no pending Activities/Nexus work,
provider locks or unresolved dispatch leases. They fetch complete, bounded native
histories of each exact original running RunId without following replacements,
check history length/event sequence, and replay against a freshly built bundle
from the verified runtime source. Only hashes and plain metadata projections are
saved; history payloads stay in memory. This establishes source compatibility,
not deployed-image bundle identity. Orchestration needs separate image-bound
workflow evidence before its own promotion can be implemented.

An immutable attempted checkpoint saves the exact target, original conflict token,
request identity, resource identities, replay/queue/protection hashes and original
timestamps before one nonretrying `SetWorkerDeploymentCurrentVersion` RPC. A fresh
native scan and an original-authority transaction follow that checkpoint, with
freshness checked again immediately before the RPC. Definitive native rejection
remains rejected; uncertain transport outcomes permit GET-only reconciliation and
never a second mutation. Matching may expose its new queue routing after the RPC
acknowledgement, so the postcondition waits by bounded GET before the full scan.
Completion requires exact desired controls routing, unchanged shared-deployment
routing and original protected history/lease inventory. An unknown ACK's desired
observation is explicitly not causal proof. There is no rollback, admission,
provider-epoch, WCI, old-worker retirement or readiness advance.

`scripts/integration/temporal-controls-promotion.native.mjs` joins the actual local
SDK CAS, full original-run replay and dedicated Firestore intent/checkpoint path.
Cloud Run resources and permissions in that fixture remain controlled responses.
Native routing/history records are projected into plain metadata before Firestore
checkpointing; raw SDK message instances are not persisted.

`promote-cloud-run-search` follows controls. Its twelve distinct receipt IDs are
its own nine preparation receipts, completed bootstrap cycle, retained activation
and the completed controls promotion. Search still accepts no Storage receipt or
bucket policy authority. Its mounted numeric search configuration metadata and
owned project/Auth/Firestore permissions are rechecked without vendor calls.

The controls predecessor must retain its original CAS token/request, attempt and
completion times, resource identities, replay/protection hashes and pre/post
routing evidence. The controls producer and search consumer share the same pure
completed-receipt validator; current routing cannot replace a missing original
intent. Each producer plan preserves its own operation binding, joined to its
immutable receipt. Controls and search bindings are deliberately distinct because
their controller arguments include different roles, settings, runners and receipt
manifests. Shared release, source/CI/image evidence and build identity must match;
the consumer never substitutes its binding for the producer's.

Search also reads controls' native current deployment, exact Activity-only queue
inventory, actual queue routing and pollers before its attempt and on readback.
Its own fixed search observers, checkpoint field and immutable receipt prefix
cannot accept a controls action or another role. All original history/lease,
paused authority, single-CAS, definite-rejection and unknown-ACK fences remain.
The native fixture runs controls first, consumes its actual completed Firestore
receipt under a distinct search binding, and checks both roles' authority drift
without additional mutations. This is local SDK evidence with controlled Cloud
resource observations, not deployed search delivery or effective credential proof.

## Connected independent promotion sequence

The fixed source sequence is controls, search, email, images and media.
Controls through images have connected canonical operations. Media has a fixed
canonical denial before credentials or operations until native allocation,
statfs/reservation, same-host canary and recovery evidence is connected. Email consumes the completed search certificate; images consumes email;
media consumes images. Their manifests require respectively twelve, fourteen and
fourteen distinct owned receipts, including their own preparation, completed
bootstrap cycle, retained activation and immediate predecessor promotion.
Orchestration promotion remains a separate, unimplemented final step requiring
image-bound Workflow replay and protected original-work evidence.

Every later action freshly checks the entire earlier role prefix: each native
current deployment/version, zero ramp, exact Activity-only queue, queue routing
and current pollers. The original immediate predecessor certificate retains its
own binding and receipt hash; its aggregate chain hash is distinct from its own
resource receipts. A historical completed certificate cannot replace fresh
ancestor routing. Checks run before the attempt and during post-observation and
GET-only reconciliation.

Email accepts no Storage authority. Images and media retain their exact approved
bucket identities, scoped policies, numeric secrets and retained pool identity.
The planned media routing step preserves retained quota evidence and the
100 GiB disk budget without another allocation or quota request, but this does
not replace its still-required native capacity gate. The media action remains
hard-stopped and has no bypass flag. The actual
canonical native connection disables both SDK interceptors and gRPC retries for
all five promotion purposes. Each operation saves its exact conflict-token request
before one CAS; rejection and unknown-acknowledgement fences remain unchanged.
No role promotion scales a pool, opens admission, advances the release phase,
retires old workers or attaches WCI.

The expanded local SDK/Firestore fixture creates each predecessor through the
actual source operation with distinct bindings before promoting its successor.
Controlled Cloud resource fixtures and a verification Workflow bundle do not
establish Cloud Run acceptance, image-byte compatibility, effective credentials,
process counts, drainage, provider behavior or staging readiness.

## Connected role cycles and kept activation

`bootstrap-stop-cloud-run-controls` uses a SHA-pinned private manifest containing
exactly eleven distinct completed preparation operation IDs: runner, scaler, pool,
three scaler grants, Firestore grant, and project/storage role definitions and grants.
The controller rederives their source plans and checks native identities and policies.
It persists an immutable activation record before observing registration; each scale
request and its authorization remain immutable after its saved attempt. Known LROs
resume; unknown ACKs use GET only and never resend or assert causality.

The equivalent orchestration actions are `bootstrap-stop-cloud-run-orchestration`,
`activate-cloud-run-orchestration-pool` and
`stop-cloud-run-orchestration-activation`. Each has a separate fixed checkpoint
field and immutable receipt prefix; a descriptor cannot select another role or
reuse a controls receipt. Orchestration rechecks its own operational alert/admin
secret settings and existing narrow Auth, RTDB and Storage grants. No new grant
semantics are introduced by activation.

Controls registration requires exactly its Activity queue. Orchestration requires
exactly its Workflow and Activity queues, both named `urm-orchestration`. Foreign,
shared, duplicate or unsupported queues deny registration and unused-pool stop.
Partial expected registration can wait while warming; it cannot satisfy completion.
Starting orchestration non-current is distinct from promoting it. This enables a
future separately guarded pinned inert verification operation; this change does
not implement that operation or relax the final current-version readiness gate.

Search has separate fixed `bootstrap-stop-cloud-run-search`,
`activate-cloud-run-search-pool` and `stop-cloud-run-search-activation` actions.
Their manifests contain nine base receipts, ten with the completed bootstrap
cycle, and eleven with the retained activation. Search has only its source-derived
project Auth-read role and conditional Firestore access; Storage role/access
receipts are rejected, and bootstrap does not query a bucket policy. Its
`TEMPORAL_SEARCH_CONFIG_JSON` environment binding must reference an enabled
numeric version of `TEMPORAL_SEARCH_CONFIG` with the owned runner accessor.
External search credentials remain capabilities; this does not prove their
runtime validity or authorize a vendor request during bootstrap.

The independent Cloud Run search entrypoint now registers Activities only on
`urm-search`. Traditional search workers retain their existing Workflow/Activity
ownership. Worker construction and readiness share the source decision, and the
native local fixture uses it to assert the exact Activity-only queue inventory.
This change fixes the previous source mismatch where the real Cloud Run search
entrypoint would have registered an extra Workflow queue and failed the new gate.
The actual entrypoint test checks Worker options and readiness for both hosting
modes; native metadata confirms only the tested local SDK registration.

Email has its own fixed `bootstrap-stop-cloud-run-email`,
`activate-cloud-run-email-pool` and `stop-cloud-run-email-activation` actions and
separate checkpoint/creation/retained receipt namespaces. Like search, its exact
nine/ten/eleven receipt manifests reject Storage authority. Its project role is
Auth read only, with the same conditional Firestore prerequisite.

Email bootstrap rederives the source template including
`EMAIL_EGRESS_DESCRIPTOR_PATH=/run/email/egress.json`, the mounted numeric version
of `TEMPORAL_EMAIL_EGRESS_DESCRIPTOR`, and any approved numeric runtime secret
bindings. Each referenced version must be enabled with the owned runner accessor.
This reads metadata only. Staging `createEmailRuntime` selects private capture;
startup and registration therefore do not validate descriptor contents or exercise
provider transport. The existing bounded no-send TLS/auth verification remains a
separate readiness gate. Bootstrap never calls delivery or infers SMTP permission.
The Cloud Run email entrypoint and readiness now share Activity-only ownership;
traditional email Workflow/Activity behavior remains unchanged.

Images has separate fixed `bootstrap-stop-cloud-run-images`,
`activate-cloud-run-images-pool` and `stop-cloud-run-images-activation` actions,
with eleven/twelve/thirteen owned receipt manifests. Its rederived Storage grant
and fresh native bucket identity use only `urm-app-staging-images`; the audio
bucket cannot substitute. The original bucket creation time, project identity,
custom-role permissions/etag and runner UID remain bound before writes and resume.
Its existing narrow role includes object get/delete/update, not object creation;
project Auth read and RTDB get/update authority remains explicit.

Read-only grant observation shares the preparation IAM parser. It accepts the
pre-existing unconditional `allUsers` / `roles/storage.objectViewer` baseline only
on that exact images resource. Public writers, authenticated-user members,
conditional public reads, or public bindings on another resource are rejected.
Requested grant members remain owned service accounts. Bootstrap performs no IAM
write and makes no inherited/effective isolation claim.

The Cloud Run images entrypoint and readiness share Activity-only ownership;
traditional images behavior is preserved. The source-bound template remains one
CPU, 2 GiB memory and 256 MiB in-memory scratch. Exact template/queue observations
are not native API resource acceptance, image-processing capacity or runtime
Storage access proof. Existing approved-bucket execution guards and legacy records
are unchanged; bootstrap does not repair or rewrite missing bucket identities.

Both stable work scans and the final refreshed namespace compute inventory must
remain within five seconds; a long scan is a denial, not renewed freshness. Every
open execution must be pinned to a different registered version, without pending
Activities/Nexus operations. Every critical marker/provider lock, active provider
session, unresolved dispatch record/lease or candidate execution denies the cycle.
These conservative checks can reject retained old work; do not clear any record to
make them pass. They are observations, not a cross-API exclusion or drainage proof.

The source-owned role authorization callback also executes at the HTTP boundary
**after** the controller obtains its Google credential. It rechecks the original
protection and complete namespace-compute inventory digests and component freshness;
a slow credential refresh or intervening authority/routing/inventory change cannot
reuse the earlier authorization. Existing API callers retain their response/status
semantics; JSON descriptors cannot supply this callback.

The same-parent cycle always targets desired zero after observation, including
unconfirmed observation. It refuses a stop after candidate work/routing/authority
drift. Desired zero does not establish native process termination or drain. `activate-cloud-run-controls-pool` consumes that exact completed cycle as its new
origin: same UID/revision and original generation plus two, desired zero and its
native etag. Its twelve-ID manifest adds `bootstrapCycle` to the eleven original
receipts. After one saved scaling PATCH it commits the native activation record
before observation. Only fresh non-current registration/protection and exact
count-one identity produce a completed `retained` receipt. Count one remains
transitional billed compute; it proves neither live poller identity nor readiness.

An observation failure produces a distinct same-parent stopped outcome, never a
successful kept-activation receipt. An unknown retained-completion checkpoint ACK
retains the fence; it never infers a cleanup decision. Resume observes the existing
pool and native registration without resending the start or renewing old receipts.

`stop-cloud-run-controls-activation` adds that exact completed retained `activation`
receipt to the manifest. It checks the original cycle/activation plans, current
UID/revision/generation/etag, grants, compute absence and unused/non-current work
protection before its sole saved conditional stop. A current or working candidate
cannot be forced to zero. Cleanup has no authorization-expiry shortcut. Desired
zero still proves neither process termination nor drain. After this stop, the
original cycle origin cannot authorize another activation; a new origin requires a
separately reviewed contract. Actual media capacity and guarded promotion remain unproved.

Any extension to other roles and the later handoff must retain these requirements:

1. Retain the existing full source/CI/tree/image and paused release-authority
   guards. Join immutable completed runner, zero-pool and scoped-access receipts,
   plus fresh exact account IDs, secret versions, pool UID/generation/etag/template
   and current native policies. Do not adopt a pool by name.
2. Read complete native namespace deployment/version inventories and require
   compute associations absent before observation and immediately before the
   guarded write. Bind the original routing and protected running-work inventory;
   inspect pending Activities and provider leases. Pause does not stop old timers,
   Activities or callers that can explicitly target a version. Unknown work is a
   denial, not an empty inventory. Preserve every old pinned worker.
3. Persist the exact scaling-only etag PATCH and immutable attempt before one
   request changes desired manual count from zero to one. Save a known native LRO
   before polling. After an unknown ACK, use original-identity GET reconciliation
   without another PATCH or a causality claim. A conflict/rejection stays fenced.
4. Collect a separate native bootstrap registration proof. It must join the exact
   candidate DeploymentVersion, actual queue inventory and authenticated current
   pool/revision/build/runner observations without requiring that version current.
   This proof cannot substitute for the final current-routing role-readiness gate.
5. Keep the transition explicit and bounded in configuration. Desired manual count
   one is not an observed live process count or a hard billing cap. Provide a
   separately guarded original-identity stop/drain/reconciliation path; do not
   force zero while work, an unknown lease or the protected handoff remains.
   Media capacity/filesystem and safe Hetzner acquisition guards remain required.

The official Cloud Run API supports a scaling-only worker-pool PATCH and an etag,
returning a long-running operation. Changing manual count does not create a new
revision. Its desired count and reconciliation metadata
must not be described as actual native instance or restart evidence:
[manual scaling](https://docs.cloud.google.com/run/docs/configuring/workerpools/manual-scaling),
[worker-pool REST resource](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.workerPools).

## Routing and restart remain separate guarded effects

Promotion needs its own original routing conflict tokens, exact-history replay
and protected original-run/pending-Activity/provider-lease safety inventory. Old
pinned work may continue on retained old workers. Independent roles precede
orchestration; prefer the existing normal continuation boundary. After routing
and handoff, require fresh version-wide drainage before audited retirement or
WCI attachment. No override belongs in a readiness check. Do not repeat the held
job's accepted repair or alter its resources.

A Cloud Run process-recovery operation must identify the actual old and replacement
processes from authenticated native runtime observations and join the same original
probe run before and after replacement. Local PID changes, descriptor booleans or
a desired manual count cannot authorize that claim. Preserve a nonzero active
candidate during the reviewed transition. WCI stays detached until traditional
pollers and unknown work are authoritatively drained and retirement is audited.
The existing recovery/dispatch hard stop remains in place.

## Media disk quota boundary before zero-pool creation

The [worker-pool ephemeral disk guide](https://docs.cloud.google.com/run/docs/configuring/workerpools/ephemeral-disk)
explicitly documents disk volumes up to 100 GiB, including per-instance and
regional quota requirements. This clarifies the generic Volume reference's
ambiguous memory-only field description. Native read-only staging quota metadata
on 2026-10-20 reports effective 100 GiB for both instance and regional limits in
us-central1. This is an operator observation, not candidate allocation or available
capacity. No quota increase was requested.

The canonical `prepare-cloud-run-pool` action now requires exact native Cloud
Quotas identities, byte units and the explicit us-central1 effective values before
creating a zero-target media pool. Desired/pending values, ambiguous locations,
rollouts and malformed responses cannot authorize creation. Both original component
timestamps and the stable metadata digest survive the saved attempt and are
checked again after Google credential acquisition immediately before the one POST.
The source template remains 100 GiB disk, two CPUs and 4 GiB memory; existing
20 GiB source/output, 64 GiB workspace and 16 GiB headroom budgets are unchanged.

All zero-pool creation also rechecks the original owned operation and paused
control/state snapshots in a read-only Firestore transaction at that HTTP boundary.
The original attempted prerequisites, quota evidence, compute isolation, timestamp
and known native operation cannot be replaced or rolled backward by checkpoints.
This does not make Firestore and the Cloud API atomic.

The quota value is a currently enforced limit, per the
[Cloud Quotas resource definition](https://docs.cloud.google.com/docs/quotas/reference/rest/v1beta/folders.locations.services.quotaInfos).
It is not usage, free disk, a reservation, native filesystem allocation or process
proof. Actual allocation, existing runtime statfs/reservation guards, a same-host
canary and application recovery evidence remain necessary before media promotion
or readiness. Media bootstrap/retention actions are now source-connected as described below; no native Cloud Run activation has been performed.

## Connected media bootstrap, retained activation and unused stop

`bootstrap-stop-cloud-run-media`, `activate-cloud-run-media-pool` and
`stop-cloud-run-media-activation` have fixed role-specific checkpoint and receipt
namespaces. Their eleven/twelve/thirteen-ID manifests join the original owned
pool, runner, scaler and existing narrow project/Storage grants. The media pool
retains its existing Activity-only `urm-media` ownership in both hosting modes.

Only a zero-to-one allocation reads sufficient fresh native disk quota metadata.
Both original component timestamps and the quota digest remain in the saved
attempt and must still agree after the awaited checkpoint and after credential
acquisition, immediately before PATCH. A later fresh read cannot renew the original
attempt's clock. The exact source resource template and budgets remain unchanged.

Quota metadata cannot obstruct deallocation of an already allocated, unused pool.
One-to-zero preserves and validates the original allocation evidence, then requires
all exact pool identity, paused authority, compute isolation, non-current routing
and unused-work checks. It does not perform a new quota GET or claim current
capacity. Thus quota API failure or a lower effective limit cannot strand otherwise
authorized same-parent cleanup; an active or uncertain candidate still cannot be
forced to zero. Unknown ACKs remain GET-only, with no automatic resend.

The native local fixture now checks all six exact queue inventories and each
current-routing denial after a positive zero-open baseline. This demonstrates the
local SDK routing/metadata guard only. No media processing, disk allocation,
available filesystem capacity, effective runtime access, Cloud Run process
recovery, promotion, WCI handoff or staging readiness follows from these tests.


## Owned media startup filesystem observation

The staging Cloud Run media entrypoint now checks for the current canonical media
bootstrap/retained-activation operation before creating any worker poller. Its
existing immutable attempted scaling checkpoint is the original startup intent:
operation/release/binding, source CI/image evidence, pool UID/revision, runner,
exact request and unchanged 20/20/64/16 GiB budgets. The operation saves this
checkpoint before the single scaling PATCH. No new Workflow or Activity queue,
signal, caller-supplied path or periodic probe is introduced.

Only that owned media intent under the original paused control/state authorizes a
private startup receipt. The process joins its previously authenticated Cloud Run
pool/revision/runner/image witness, verifies `/tmp` resolves directly to a separate
scratch filesystem, checks actual available bytes against the 80 GiB workspace
and headroom requirement, and uses the existing application reservation guard.
A one MiB random private file is written, read and fsynced, then removed; the
reservation is released and reacquired. Native filesystem operations and cleanup
are awaited, with deadline/drain checks between operations. A deadline is not a
claim that an outstanding syscall has stopped. No sparse or full 80/100 GiB
allocation, media processing or interruption recovery is claimed.

Receipt creation uses one transaction attempt, rechecking original control/state
versions and the immutable operation intent. A known rejection remains fenced;
unknown acknowledgement permits exact readback only, with no second create.
Another process or observation cannot overwrite the original receipt. Browser
clients, including admins, cannot read or write this collection.

The canonical frozen-runtime media registration adapter now requires this receipt.
It waits boundedly by GET for the exact original operation's startup receipt while
checking that intent and authority remain unchanged; prior registration can persist
while desired count is zero and cannot establish that a new process has started.
It joins the receipt to fresh native pool UID, serving revision UID/image/runner,
then obtains actual native registration. Original registration timestamps are
preserved and must remain within five seconds after all awaits. The filesystem
sample retains its own timestamp and a 120-second maximum age; it is not an
available-capacity lease or a live process-count observation.

A normal later cold start without a matching guarded media operation creates no
such diagnostic receipt. This mechanism does not authorize business work or
replace the per-Activity reservation guard. Local filesystem tests use real one
MiB I/O with controlled mount/capacity metadata; Firestore tests use the real
canonical checkpoint and create/readback protocol with controlled Cloud metadata.
Actual Cloud Run allocation/mount acceptance and same-host execution, processing,
interruption recovery and image-byte verification remain required. The media
promotion denial remains fixed with no bypass flag.


## Synthetic native media processing and child cancellation

The owned startup intent now requires `filesystem-and-native-audio-v2`; the
capacity receipt uses schema 2 and includes mandatory processing evidence.
Earlier filesystem-only intents or receipts cannot authorize the new observation.
The actual startup entrypoint uses the immutable image's exact root-owned,
non-writable `/usr/local/bin/ffmpeg` and `ffprobe` executables and hashes their
resolved bytes. Test callers may select installed local tools, whose digests do
not establish the image's tool identity.

Within the existing private reserved workspace, the source creates a fixed
one-second, mono, 16 kHz PCM WAV. A file-only realtime ffmpeg pass loops this
synthetic input until measured positive progress triggers deliberate cancellation.
The existing application command runner must observe child close before rejection;
unknown termination, no progress or ordinary failure blocks the retry. A fresh
command then transcodes to a new private output with a fixed half-volume filter.
The probe checks duration and stream format through ffprobe and verifies every
actual PCM sample against the expected transformation. Exit status alone cannot
produce a successful receipt.

No source URL, provider call, network protocol, user media, SMTP or task authority
is involved. The fixed overall startup deadline still covers the processing pass,
with checks after native settlement and cleanup. A failed pass releases the real
workspace reservation before another attempt can use it. The diagnostic evidence
proves synthetic processing and child cancellation/retry on that startup process;
it does not prove application Activity execution, large-input capacity, an original
Cloud Run worker's replacement, durable media-job adoption or pinned-image bytes.
The unconditional media-promotion denial remains until those separate gates are
implemented and proven.

## Local durable media artifact adoption after process replacement

The existing serial recovery suite also runs a separate, emulator-only OS process
fixture. A test-only Workflow schedules the application's actual `acquireMedia`
Activity on an isolated unversioned queue. The first child downloads a synthetic
one-second PCM input from the dedicated Storage emulator, runs the installed local
ffmpeg/ffprobe through the application path, and commits source and processed
artifacts to the dedicated Firestore emulator. The fixture withholds the Activity
completion acknowledgement only after that source work returns. It kills that
exact detached child and confirms the original process group is absent before
starting a distinct OS child.

The replacement executes attempt two of the same scheduled Activity in the exact
original Workflow Run ID. The retained processed-artifact branch must return
without updating the request or allocating another artifact. Both artifacts'
complete version inventories, current generations, sizes and checksums are
compared; downloading an old pinned generation alone cannot establish that no
overwrite occurred. Separate cases replace the processed generation or supersede
the media owner before recovery: the former must fail without adopting the
changed object, and the latter must return superseded without processing again.

The fixture uses controlled authorization, small process-local test budgets,
installed local tools and a test-only Workflow. It does not run the application's
worker bootstrap, production Workflow, Cloud Run platform, pinned image or live
provider recovery. It creates no release receipt or promotion authority. The
media-promotion denial remains unconditional; image-bound Cloud Run process
replacement and the remaining native platform gates are still required.

All requests and cleanup steps have fixture deadlines. Cleanup independently
stops every originally owned process group even if its leader already exited,
then removes only this unique fixture's emulator documents, references, objects
and progress. A deadline is a failed observation, not proof that a native call
settled. Test failure and cleanup failures remain failures of the overall suite.

## Exact-image offline replay before native promotion

The canonical independent-role promotion adapter now obtains replay bytes from
the exact digest already joined to source, CI and native build evidence. It no
longer rebuilds a Workflow bundle from the operator checkout. The fixed runner
reads `/workspace/apps/temporal-worker/lib/workflow-bundle.js` and the baked build
ID inside that image, then uses the image's installed production SDK to replay.
Missing local images, digest/build mismatches and unsupported envelopes stop the
operation; there is no pull, tag or caller-supplied bundle fallback.

Replay uses only a local Unix Docker socket and a private empty Docker client
configuration. The container has no network or host mounts, runs as `node` with
a read-only root, dropped capabilities and no-new-privileges, and has bounded
CPU, memory, temporary storage, process count, input, output and deadlines. The
serving entrypoint is replaced by the source-fixed runner; no application worker
or provider client starts. Histories enter through stdin and are not written to
the private receipt directory. The frozen runtime's pinned SDK serializes native
histories with `historyToJSON`; the image decodes them with `historyFromJSON`.
Original native-history and transport-JSON hashes remain separate.

Each private, create-only intent precedes one inert container creation. Its saved
CID and exact native configuration establish ownership before one recorded start.
Unknown creation without a CID stays inert and fenced; names cannot establish
ownership. A failed or interrupted start is not resent. Native stopped state and
owned-container removal must be confirmed before a successful receipt is returned.
Interrupted removal can reconcile exact-CID absence from its original ownership
proof and removal intent without another start or removal. Cleanup remains
available after the work deadline. Result receipts bind the image/config ID,
platform, build, actual bundle digest, fixed runner digest, original operation,
source/CI evidence, exact Workflow Run ID and both history hashes.

Controlled Docker contract tests and an actual LOCAL payload-bearing history
replay test cover this source seam. The latter uses controlled image filesystem
and Runtime ownership with the real installed SDK and native replay engine.
Neither establishes execution in the final candidate image. Actual Docker/image
acceptance and the Cloud Run worker's consumption of those same bundle bytes are
still required. Media promotion remains unconditionally denied, and orchestration
promotion remains unavailable until its separate final gates are implemented.


The Cloud Run orchestration startup now reads the fixed image bundle once through
a bounded, stable owned descriptor, verifies the baked build ID, and supplies the
held code directly to `Worker.create`. Fatal UTF-8 decoding preserves any BOM in
both startup and offline replay, so the consumed code round-trips to the hashed
bytes. Traditional workers retain their existing bundle path; independent roles
remain Activity-only.

Private readiness receipt schema 2 includes that startup evidence only for
orchestration. The canonical final collector independently inspects the exact
image, pins its bundle digest in the immutable start intent, and requires the
native receipt to match. Old schema, missing evidence and changed image digests
are fenced, including GET-only reconciliation. Controlled filesystem and native
LOCAL SDK/Firestore tests do not establish final image or Cloud Run acceptance.
Media promotion remains fixed-denied and orchestration promotion unavailable.


Owned media startup intent v3 and capacity receipt schema 3 now require a separate
64GiB filesystem-accounted allocation before the synthetic audio check. The
source-fixed isolated Python program uses `posix_fallocate`, fsyncs and verifies
size, allocated blocks and the original descriptor identity. Unsupported systems,
sparse results, insufficient sampled headroom and uncertain child drain fail
closed. There is no smaller-file fallback. The allocation stays outside the
application workspace, on the same scratch filesystem, until audio processing
settles. Native original paused authority is rechecked after allocation and before
audio; all owned allocation/workspace cleanup finishes before reservation release.

The receipt joins the original operation, image, runner, revision and instance to
the fixed program hash, interpreter hash, filesystem sample, allocation duration
and confirmed cleanup. It establishes a point-in-time filesystem sample only.
Headroom is sampled, not guaranteed continuously; neither physical backing nor a
lasting capacity lease is claimed. The native child test allocates only one MiB
on supported Linux and must fail closed on this local macOS host. No 64GiB local
allocation, final-image execution or Cloud Run allocation has been performed.
Media promotion remains unconditionally denied pending its other native gates.

## Owned application child birth and normal close

The image's fixed launcher now supervises one real application `index.js` child
for an exact in-progress, paused media bootstrap or retained activation. Its
private `_control/temporalMediaKernel-<operationId>` journal binds the original
canonical intent, control/state versions, native pool/revision/image/runner,
parent witness, birth intent, actual ChildProcess PID and distinct child witness.
Intent v4 and outer capacity receipt schema 2 require the birth link; the inner
allocation/processing evidence remains schema 3. Old startup evidence cannot be
relabelled. Ordinary cold starts without this capability retain their original
entrypoint and create no kernel journal.

The parent persists intent before its sole fork and acknowledges birth before
allowing the child to enter startup. A second journal acknowledgement joins the
child's native witness before capacity admission or polling. Original authority
and the original 120-second start deadline are rechecked after awaited writes or
unknown-ACK GET reconciliation and immediately before each IPC grant. A linked
child whose original operation disappears fails closed. The journal accepts only
allowlisted bounded IPC, with no task tokens or credentials.

Normal shutdown forwards SIGTERM once through the original live ChildProcess
handle. Error events initiate that same owned stop; they do not establish death.
A closed fact requires actual child close and positive process-group absence.
An uncertain descendant drain produces no closed fact. Cleanup facts may finish
after authority expiry and confer no restart authority. A new parent cannot adopt
an existing journal or spawn again. Creator-owned Firebase resources are cleaned
independently, including initialization or fallback failures.

Local tests exercise actual OS children and the production IPC gate with
controlled journal/authority metadata. Dedicated Firestore tests exercise the
canonical authority and linked receipt protocol with controlled native Cloud and
birth metadata. These do not run the real application bootstrap in an immutable
image or on Cloud Run. This step does **not** implement diagnostic forced death,
a replacement child, diagnostic Workflow/Activity queues, original Activity
adoption, Cloud Run instance replacement, or recovery acceptance. Those remain
required. Media promotion remains unconditionally denied and orchestration
promotion remains unavailable; no handoff, admission or retirement advances.

### Production authorization in the local OS-adoption test

The existing serial native adoption case now obtains `acquireMedia` from the
actual `createRuntimeActivities` media factory. It uses the production execution
context, durable store, actor authorization, permission projection and artifact
validation rather than injecting a no-op authorization callback. The fixture
creates an emulator uploader and a real durable store intent/entity/job. Native
SDK execution metadata is recorded for the original RunId and worker witness.
Workspace imports are fixed to current TypeScript source, with no generated-JS
fallback; this is a test-process-only resolver, never a runtime loader.

After original child death, a distinct SDK child can adopt unchanged artifacts.
Revoking the uploader role, disabling that actor, or changing canonical sermon
ownership must deny the second execution. The original request and both artifact
inventories must remain unchanged on these denials. Replaced artifact generation
and superseded media-owner cases remain separate. All resources and actors are
local dedicated-emulator fixtures, with small synthetic byte budgets and a
test-only Workflow. This closes the controlled-authorization gap in this local
case; it does not establish paused diagnostic admission, application bootstrap,
immutable image execution, Cloud Run credentials or process recovery acceptance.

## Separate canonical media recovery cycle core (runtime unavailable)

`diagnose-cloud-run-media-recovery` now selects a separate cycle and checkpoint
kind under the existing immutable source/CI/image and paused-authority controller.
Its twelve distinct owned ancestor receipts are rederived by fixed read-only
helpers. Normal bootstrap modes, original-revision matching and promotion
consumers remain unchanged. The cycle records separate conditional requests and
native LRO facts for normal-zero → diagnostic-zero → diagnostic-one →
diagnostic-zero → restored normal-zero. The literal diagnostic deployment and
Workflow/Activity queue contract is separate from normal media routing.

The immutable plan retains the old receipts and origin, exact templates, image,
runner and source identity. Each native pool observation joins its exact revision
GET, revision UID and expected template. A template transition requires a new
revision name and UID; scaling preserves both. Post-credential fences recheck
original authority, access, work/compute evidence, pool identity and original
allocation quota freshness before the single PATCH. Unknown acknowledgements stay
GET-only and cannot authorize a later transition or another mutation.

Cleanup requires a separate authoritative runtime drain before zero and stopped
proof before restoration. If allocation never had a saved attempt, or received a
definitive rejection, an explicit `neverStarted` fact can authorize restoration
of the unchanged diagnostic-zero revision without allocating it. This path has
no fabricated start, stop or drain facts. Unknown start/checkpoint acknowledgements
remain fenced. Saved no-start outcomes resume directly to restoration, including
lost restore acknowledgements. Cleanup does not expire or require a new quota
read. Failed/not-started cycles cannot become successful recovery evidence.

**The canonical runtime adapter is unconditionally unavailable before any cycle
checkpoint or native mutation.** The real expiring diagnostic producer, private
job and actor authorization, actual image queue/config path, original live-child
signal/death/replacement journal, native recovery/drain collector and next-normal
origin consumer still require implementation. The fixed denial must remain until
that whole protocol exists; no CLI flag or controlled receipt can enable it.
Source tests use controlled Cloud and runtime adapters; dedicated Firestore tests
establish checkpoint authority, immutable progress and acknowledgement recovery.
They prove no Cloud Run API acceptance, actual diagnostic execution or readiness.
The restored revision is new lineage and cannot masquerade as the old zero-pool
receipt or a retained normal activation. Media promotion and orchestration
availability remain denied.


The canonical prepare stage now has a private native Firestore ARMING journal.
It is explicitly scoped `arming-only-no-execution-authority`; it grants no
Workflow, Activity, polling, signal or restart permission. A separate original
attempt precedes its sole create transaction. The journal binds the exact plan,
image, runner, fixed diagnostic contract, paused native authority and original
attempt timestamp. Missing/changed journals and altered attempt timestamps deny
prepared and later checkpoints. Unknown attempt/create acknowledgements never
resend; only exact completed native state can reconcile. Cleanup retains the
original journal and expiry, without renewing work permission. The runtime
preflight remains unconditionally unavailable, so the CLI cannot reach this
arming stage until the complete private execution protocol is implemented.

The fixed `MediaRecoveryProbe` Workflow and private work admission Activity are
implemented in source. Admission joins the exact saved SDK start nonce and time
to native event 1, the original Run ID, pinned diagnostic deployment, paused
journal and current Firebase admin. It uploads only source-fixed synthetic PCM,
then transactionally uses the production durable-job builder while withholding
its ordinary outbox write. The resulting private acquire-only grant binds the
original run, source generation and request. Existing object names or canonical
owners cannot be adopted. Unknown upload acknowledgement permits owned readback
only; native failures cross a fixed sanitized Activity boundary.

The dedicated local integration case runs this Workflow and the actual media
Activity factory with real emulator-backed authorization. It covers admission
acknowledgement loss without another upload/job, revoked actors, preexisting
native runs, object/owner collisions and private-error sanitization. Cloud pool,
revision and startup witnesses remain controlled. A local SDK/emulator collision
case accepted an upload despite its generation-zero option; the source now also
requires observed absence before the first upload intent. That read is not an
atomic race fence, and actual backend conditional-write acceptance remains a
required native platform check.

This source is not reachable through the canonical diagnostic CLI: preflight
continues to deny execution. The canonical SDK-start writer, diagnostic image
queue registration, supervisor fault/death/replacement/adoption collector and
restored-normal lineage consumer remain pending. Ordinary media remains
Activity-only, media promotion remains denied, and orchestration promotion
remains unavailable. No Cloud Run or immutable-image execution is established by
the local producer case.
