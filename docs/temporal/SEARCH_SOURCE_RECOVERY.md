# Recover running pinned search work without relabeling a release

`scripts/temporal-recover-pinned-search.mjs` is a narrow staging operator for the
580 search-onboarding incident. It preserves the original job, intent, entity
generation, workflow ID and run ID. It does not resume a job, restart/reset a
workflow, change canonical status, deploy code, promote a version, change release
control, or open admissions. Use normal authenticated durable job actions to
resume work only after the reviewed routing change.

The old release must be exactly
`d6401173-c28b-42e9-ba75-f7c714e289c2`, backend-ready revision28, source580f5f56,
globally paused. All seven owners are Temporal, search admission is paused and
the other six domain admissions retain open. The original native cutoff and
full grace must remain valid. A changed release/revision/phase requires a new
reviewed recovery scope; this tool does not generalize its authority.

## Prerequisites

First settle the timed-out bootstrap and inspect the actual release operation.
An absent operation stays absent until this tool acquires its own operation;
never “resume” an absent old lock. Preserve original logs, descriptors, five
bootstrap receipts, actual provider task acknowledgements, jobs, intents,
outboxes, entity generations, execution heads and worker-settled witnesses.
Timeout does not prove a workflow closed or undo writes already published.

Commit and validate the corrected Activity code as a new full SHA and image
digest. Supply a distinct target release descriptor, target runtime checkout and
normal reviewed platform configuration. The operator itself must be committed
at that target SHA; it cannot pretend to be580. The existing committed checkout,
resource-binding and bounded local ADC helpers verify source, exact staging
Firebase resources and the actual Google operator matching gcloud. No credentials
or Temporal API keys are printed or written.

Normal worker-only platform deployment can register all six corrected roles
while the old application checkpoint remains unchanged. Verify the new version
is actually Current with no ramp, all six queues and the search Workflow queue
registered, and all six actual Ready pods use the reviewed immutable image.
Quiesce old pollers gracefully only with actual execution/settlement evidence;
retain their version/resources. Do not use missing-queue or no-poller overrides.
New independently dispatched search-document workflows use Current; they are
Firestore-outbox starts, so a backfill workflow's override does not route them.

The source check deliberately does **not** materialize staging search Functions
environments for an inactive target UUID. Do not deploy target-source Functions
or repoint the old descriptor. Source supersession after actual old search-ready
is a separate reviewed operator, followed by normal deployment/bootstrap/UI
readiness. Main promotion still requires the user's staging approval.

Temporal documents the supported pinned override and its replay requirement in
[Moving a pinned workflow](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning/roll-out-and-pin#moving-a-pinned-workflow).
Root verified the installed official Temporal CLI1.9.1 help exposes exact
workflow-id/run-id/pinned/deployment/build arguments. The tool calls that CLI
first, with a private environment key, never a broad query write or reset.

## Finite manifest and real replay evidence

Create a private JSON manifest and independently review its raw SHA256:

```json
{
  "schemaVersion": 1,
  "projectId": "urm-app-staging",
  "oldReleaseId": "d6401173-c28b-42e9-ba75-f7c714e289c2",
  "oldControlRevision": 28,
  "targetCommit": "FULL_NEW_COMMIT",
  "targetImage": "EXACT_NEW_IMAGE_AT_SHA256",
  "runs": [
    {
      "jobId": "EXACT_ADMITTED_JOB_ID",
      "workflowId": "search:urm-app-staging:EXACT_ADMITTED_JOB_ID",
      "runId": "EXACT_ORIGINAL_RUNNING_RUN_UUID",
      "workflowType": "SearchDocument",
      "replay": { "path": "/private/replay.json", "sha256": "RAW_RECEIPT_SHA256" }
    }
  ]
}
```

Only SearchDocument/search.sync and SearchBackfill/search.backfill requested by
system:search are accepted. The finite unique list is bounded to500 runs; no
visibility query authorizes writes. Each entry must match actual nonterminal
application intent, current entity generation and original native running
execution/type. Closed failures/cancellations stop for separate
application-consistent recovery. A native reset alone would leave application
metadata and receipts inconsistent.

Each replay receipt has schemaVersion1,
execution `actual-temporal-sdk-replay`, exact workflowId/runId/workflowType,
targetCommit/targetImage, actual historySha256, exitCode0, and
`log:{path,sha256}` for the actual SDK replay log. The inspection verifies all
pinned files and exact live history hash. These JSON fields are operator-reviewed
receipts, not cryptographic attestation that a process ran. Never use fabricated
results or the fake adapter unit fixtures as replay evidence. Changed history
before override requires new actual replay and inspection. Replay/integration
execution belongs to root's isolated test plan, not this command.

## Inspect, override one run, report

All output paths are new exclusive0600 files. Use Node22 and absolute private
paths. The same old/target/runtime arguments are required in every action:

```sh
node scripts/temporal-recover-pinned-search.mjs inspect \
  --old-release /private/old580.json --target-release /private/target.json \
  --target-runtime-root /private/committed-target-checkout \
  --manifest /private/runs.json --manifest-sha RAW_MANIFEST_SHA256 \
  --output /private/inspection.json
```

Inspect is read-only. It verifies actual native control/state identity, no
operation, target routing/pods, the job/entity/intent, pending activity state and
exact old execution drains. A started/cancel-requested/unknown Activity blocks;
only Scheduled/Paused or no pending Activity can proceed. Time elapsed or an
infrastructure checkbox does not replace a matching worker_settled witness.

Review the inspection and pin its raw SHA. Override exactly one listed original
workflow/run, without changing its request or job identity:

```sh
node scripts/temporal-recover-pinned-search.mjs override \
  --old-release /private/old580.json --target-release /private/target.json \
  --target-runtime-root /private/committed-target-checkout \
  --plan /private/inspection.json --plan-sha RAW_PLAN_SHA256 \
  --workflow-id EXACT_WORKFLOW_ID --run-id EXACT_ORIGINAL_RUN_UUID \
  --output /private/override.json --apply
```

The operator transaction creates immutable
`_control/temporalPinnedSearchRecovery-UUID` intent and its nonexpiring operation
**before** the CLI write. It rereads actual state immediately before submission.
The safe audit UUID is printed, never a credential. The only native write is:

```sh
temporal --disable-config-file workflow update-options \
  --workflow-id EXACT_WORKFLOW_ID --run-id EXACT_ORIGINAL_RUN_UUID \
  --versioning-override-behavior pinned \
  --versioning-override-deployment-name urm-worker-staging \
  --versioning-override-build-id FULL_NEW_COMMIT \
  --address EXACT_STAGING_ADDRESS --namespace urm-app-staging.qwejt --tls
```

An observed override is explicitly **not migration proof**. After a successful
CLI exit and exact actual override readback, only this operation is released.
Any CLI error/timeout, unknown ACK, failed readback or changed authority stops
and retains its operation/immutable intent. The tool rereads once; it never
reissues an existing override or starts another run. Inspect the actual audit
and workflow. A matching override does not prove an already-running provider
call moved or settled.

Use actual allowed revision/actions through the normal authenticated durable
job command path for search.resume, starting with documents and then affected
backfills. There is no ADC-to-Firebase-user impersonation or auto-resume here.
After actual new target execution and workflow tasks have completed:

```sh
node scripts/temporal-recover-pinned-search.mjs report \
  --old-release /private/old580.json --target-release /private/target.json \
  --target-runtime-root /private/committed-target-checkout \
  --plan /private/inspection.json --plan-sha RAW_PLAN_SHA256 \
  --audit-id EXACT_RECOVERY_UUID --output /private/migration-report.json
```

Report makes no native routing write. It permits original RUNNING or successfully
COMPLETED runs, verifies the actual target override, unchanged admission identity,
real new build/PodUID/container/instance execution heads with worker-settled
drains, and actual WorkflowTaskCompleted identity from the live target search
pod. Workflow and controls Activity pods are correctly distinct. It creates an
immutable report audit, releasing only its own retained operation if present.
Missing new evidence leaves it blocked; a CLI ACK alone cannot become PASS.
Successful owned SDK cleanup and process exit are required; output is written
only after cleanup succeeds.

After the original jobs actually converge, normal OLD580 bootstrap-search may
acquire a new operation and reuse the original five receipts to reach actual
search-ready **without opening**. Refresh the exact approved settings receipt if
needed, retaining older evidence. Only then perform the separately reviewed
search-ready source supersession and fresh successor gates. Never relabel580,
rewrite failed jobs to succeeded, force-open admission or discard uncertain
provider effects.

## Verification scope

`node --test scripts/temporal-recover-pinned-search.test.mjs` contains pure policy
and fake-adapter tests for exact scope, source/version identity, native grace,
finite CLI arguments, stale generations, started Activities, missing drain
witnesses, unknown ACK stop/no recall and actual-evidence report gates. Fake
fixtures are explicitly not live replay or IAM proof. Before operational use,
root must run the real SDK replay/native integration cases, including pending
Activity rerouting, new Current outbox starts, source-backed execution witnesses,
unknown ACK readback and original-run convergence. No live execution is implied
by source review or passing unit tests.
