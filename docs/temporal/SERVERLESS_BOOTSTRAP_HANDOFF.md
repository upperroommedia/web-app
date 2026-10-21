# Serverless bootstrap and process recovery boundary

The guarded controller now has all six role-specific **bootstrap and stop cycles** in
source. It joins the owned zero-pool/account/grant receipts, starts desired manual
count one, observes the exact native non-current role queues, then stops the same
owned pool under the original parent. Observation failure also enters owned stop;
uncertain authority, protected work or an unknown result retains the fence.
The source also connects a kept-running role-specific activation and a separate stop of
that exact unused activation. None of these operations has been applied to Cloud Run.
Controls-only guarded native promotion is connected in source. Promotion of the
other roles remains unimplemented, and no promotion has been applied to staging.

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
