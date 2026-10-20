# Serverless bootstrap and process recovery boundary

The guarded controller now has a controls, orchestration, search and email **bootstrap and stop cycles** in
source. It joins the owned zero-pool/account/grant receipts, starts desired manual
count one, observes the exact native non-current role queues, then stops the same
owned pool under the original parent. Observation failure also enters owned stop;
uncertain authority, protected work or an unknown result retains the fence.
The source also connects a kept-running controls, orchestration, search or email activation and a separate stop of
that exact unused activation. None of these operations has been applied to Cloud Run.
Media and images activation and guarded promotion remain unimplemented.

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
old pinned waiting-run inventory, non-current controls/search/email Activity and orchestration Workflow/Activity registration,
provider-lock preservation, and explicit candidate-run denial against the dedicated
Firestore emulator. Controlled Cloud API tests cover the scale/stop protocol;
the actual Firestore checkpoint regression checks paused authority, immutable
activation-before-observer, and post-attempt stage rollback denial.

These observations apply to the tested local Temporal CLI 1.9.1 / Server 1.32.0 /
TypeScript SDK 1.24.0 configuration. They do not establish general no-work isolation,
Cloud Run process replacement, native cloud delivery, effective IAM or readiness.
In particular, non-current is not a fence against explicitly routed tasks.

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
separately reviewed contract. Media and images activation, media
capacity and guarded promotion remain out of scope.

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
