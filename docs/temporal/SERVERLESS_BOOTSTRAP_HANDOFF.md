# Serverless bootstrap and process recovery boundary

The guarded controller is not yet able to bootstrap candidate worker pools. Its
preparation operation creates owned pools with desired manual count zero, while
the final native role-readiness collector requires the candidate versions already
current, with no ramp, on the real role queues. Neither a completed zero-pool
receipt nor a role-readiness helper starts a poller or changes routing. Do not
bypass the final readiness collector to bridge this gap.

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

These observations apply to the tested local Temporal CLI 1.9.1 / Server 1.32.0 /
TypeScript SDK 1.24.0 configuration. They do not establish general no-work isolation,
Cloud Run process replacement, native cloud delivery, effective IAM or readiness.
In particular, non-current is not a fence against explicitly routed tasks.

## Required connected bootstrap operation — not implemented

The next operation must start one owned candidate role pool manually without
promoting any version or attaching Worker Compute Infrastructure:

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
returning a long-running operation. Its desired count and reconciliation metadata
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
