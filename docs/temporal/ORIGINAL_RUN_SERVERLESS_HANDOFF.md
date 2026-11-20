# Same-original-run handoff from shared pinned workers

Official docs/source checked 2026-10-20. The research and guard sequence do not authorize live mutation. The local synthetic probe described below is separate from staging or application recovery; no staging override, provider action or worker retirement has been performed.

## Supported mechanism and selected direction

Temporal explicitly supports moving a running, state-intact, nonrestartable pinned Workflow onto a **replay-safe** fixed version with Versioning Override, without Reset. Changing current/ramping version does not hot-move an existing pinned run. An application that already checks the target-version flag can instead upgrade at its own Continue-as-New boundary, as described below. This preserves the original execution; reset/new-publish/resubmission are unnecessary for this mechanism. [Recovery runbook](https://docs.temporal.io/production-deployment/worker-deployments/recover-pinned-workflows).

For this seam, the candidate target is the new **orchestration** DeploymentVersion that registers the original workflow queue/type, not the publishing Activity-only role. Targeting an Activity-only pool cannot execute the required Workflow Task. This is an architecture inference from the role split supplied by root and must be confirmed against actual deployment registrations.

## Override alternatives

The CLI supports exact `--workflow-id` plus `--run-id` and these behaviors:

- `pinned`: keep the execution forcibly pinned to specified deployment/build until override removal. This is the narrow conservative recovery choice when the exact target should remain fixed.
- `one_time`: route until one Workflow Task completes at target, then clear override and adopt the behavior/version reported by that worker. A worker reporting Pinned leaves the run normally pinned there; reporting AutoUpgrade allows future upgrades. No completed target WFT means the one-time override remains pending.
- `auto_upgrade`: use the Workflow's current/ramping target; this provides less exact routing and requires replay compatibility for future upgrades.
- `unspecified`: remove prior override; it is not a universal rollback command.

Illustrative **not executed** exact-run form:

```text
temporal workflow update-options --workflow-id EXACT_ID --run-id EXACT_RUN \
  --versioning-override-behavior pinned \
  --versioning-override-deployment-name TARGET_ORCHESTRATION_DEPLOYMENT \
  --versioning-override-build-id TARGET_BUILD
```

[CLI reference](https://docs.temporal.io/cli/command-reference/workflow#update-options). [Move/AutoUpgrade guidance](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning/roll-out-and-pin).

## Exact API fields and version caution

`WorkflowService.UpdateWorkflowExecutionOptions` accepts `namespace`, `workflow_execution { workflow_id, run_id }`, `workflow_execution_options`, `update_mask`, and `identity`; response returns resulting options. Use a whole-field mask `paths: ["versioning_override"]`, preserving unrelated options. This API schema contains no expected-old-override conflict token or caller request-id field: an operator guard requires a fresh read and exclusive ownership. A transport-unknown response requires readback, never blind retry. [Workflow service request/response proto](https://raw.githubusercontent.com/temporalio/api/master/temporal/api/workflowservice/v1/request_response.proto).

The CLI v1.9.1 source pins API v1.63.5. That exact API tag includes `one_time`; an earlier fetched master page omitted it, so avoid using an unpinned/stale master schema as compatibility proof. [CLI pinned dependencies](https://raw.githubusercontent.com/temporalio/cli/v1.9.1/go.mod).

Illustrative protobuf JSON shapes for the selected field:

```json
{"pinned":{"behavior":"PINNED_OVERRIDE_BEHAVIOR_PINNED","version":{"deploymentName":"TARGET","buildId":"BUILD"}}}
```

```json
{"oneTime":{"targetDeploymentVersion":{"deploymentName":"TARGET","buildId":"BUILD"}}}
```

```json
{"autoUpgrade":true}
```

Pinned is a permanent override; oneTime clears upon completed target WFT and adopts worker-reported behavior/version. Prefer the structured version over deprecated deployment/pinned_version fields. [API v1.63.5 override definitions](https://raw.githubusercontent.com/temporalio/api/v1.63.5/temporal/api/workflow/v1/message.proto). [WorkerDeploymentVersion structure](https://raw.githubusercontent.com/temporalio/api/v1.63.5/temporal/api/deployment/v1/message.proto).

## Pending Activity and routing limits

Activities normally inherit the Workflow version. **Independent Activities** instead use their own queue's current/ramping version when that queue is not a member of the Workflow's pinned/target DeploymentVersion. Therefore moving the original run from the shared six-queue version to orchestration-only can make future publishing work independent; changing the publishing queue's current version while the Workflow remains pinned to the old shared version does not accomplish that. [Activity routing rules](https://docs.temporal.io/worker-versioning#activity-behavior-across-versions).

An already-started attempt is executing code on its current worker; an override is not a hot replacement of that process and is not a provider cancellation/retry instruction. Preserve the attempt's normal completion/timeout/retry behavior. Pending retries must be observed individually; do not infer that override acceptance moves every queued Activity immediately. API transition comments describe pausing new pending attempts during an AutoUpgrade transition and resuming them after target WFT completion, but explicitly exclude Pinned behavior from that transition model. Do not generalize that detail into an unconditional pinned-move guarantee. The options API implementation records an options-updated event and does not unconditionally create a new WFT. [Server options handler](https://raw.githubusercontent.com/temporalio/temporal/main/service/history/api/updateworkflowoptions/api.go).

Describe's `versioning_info.deployment_version` identifies the latest completed WFT version, distinct from requested override. `pending_activities` exposes identity, attempt/state, retry schedule, and `last_deployment_version` (nil can mean undispatched or unversioned). Join these with actual Activity receipts; neither requested override nor last dispatch proves successful fixed execution. [Generated API v1.63.5 Workflow messages](https://raw.githubusercontent.com/temporalio/api-go/v1.63.5/workflow/v1/message.pb.go).

## Guarded plan prerequisites (inference, not live proof)

1. Save exact original WorkflowId/RunId, complete private history, mutable versioning/override state, pending WFT/Activities, accepted repair/certificate/session binding and provider journal receipts. Confirm running/state intact. No reset or replacement execution.
2. Replay that exact complete history against the immutable target Workflow bundle, including the existing command/activity options and patch markers. Activity implementation fixes alone need not change Workflow commands, but independent queue refactoring can still affect compatibility. Synthetic new-run success does not prove this history replays. Temporal's TS replay facility detects nondeterminism without re-executing recorded Activity side effects. [TypeScript replay testing](https://docs.temporal.io/develop/typescript/best-practices/testing-suite).
3. Confirm the target orchestration version polls the original Workflow queue and registers its type; it excludes independent role queues. Confirm every needed independent queue has the reviewed role version current, actual readiness/witness and original safety/idempotency guards. No side-effect probe of the held provider operation.
4. Before any authorized exact-run override, independently demonstrate this precise state seam with a safe representative **already scheduled retry/backoff Activity** on the same server/SDK semantics. Required result: same run, target WFT completed, original scheduled Activity naturally retries at the fixed independent role, no reschedule/reset or duplicate side effect. If it remains pinned/backlogged or needs a new WFT that will not naturally occur, stop: docs alone have not resolved this seam.
5. After any authorized mutation, record ACK then native Describe/history readback. Require completed target WFT and natural fixed Activity receipt; observe original certified protocol completion and unchanged provider identities. Unknown ACK: read native state/history first, no resend.

## Safe retirement and WCI boundary

Native drainage is periodically refreshed. Require old versions no longer current/ramping, `DrainageStatus=drained`, and fresh `DrainageInfo.last_checked_time` after routing changed and all relevant executions moved/closed. Visibility is eventually consistent; a single zero-result query is insufficient. Drainage is version-wide, so moving the one held run does not prove the entire old shared six-role deployment is drainable. Closed-run Queries may still need old code. [Sunset/GC](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning/sunset-and-gc).

Then independently verify original active attempts/backlogs and all protected workloads are safe, perform only the separately authorized normal graceful retirement, and verify traditional pollers are gone. WCI documentation prohibits sharing a task queue with long-lived workers because it creates duplicate capacity; per-role pool/build mapping is required and image editing under a version is not a safe handoff. [Serverless Worker restrictions](https://docs.temporal.io/serverless-workers/cloud-run).

**Result:** supported same-run override exists. Safe routing of this already-pending repair from an old shared deployment into independent roles is conditional on exact-history replay and the representative pending-Activity handoff evidence above. This research does not establish those prerequisites or authorize live handoff/retirement.

## Local representative evidence

The repository now includes `pending-activity-handoff.native.test.ts` and a test-only workflow. On Temporal CLI 1.9.1 / Server 1.32.0 and TypeScript SDK 1.24.0, a shared pinned version first executes an Activity that fails without external effects. Native Describe confirms its existing scheduled retry, the original deployment and a future retry time. The target orchestration version registers only the workflow queue; the independent Activity version is current on its own queue. The test replays the captured original history before the local exact-run Pinned override.

With no signal, reset, manual Activity retry or second Activity scheduling command, native processing then executes attempt two on the independent role version. The original RunId remains unchanged, the native latest completed Workflow Task reports the target version, history contains one ActivityScheduled event and one WorkflowStarted event, and completed history replays. The test retains real SDK contexts and collects only synthetic build/run/attempt markers. Native failed-Activity logging is suppressed in this fixture because default SDK metadata includes task tokens; no raw execution history is printed. All local workers and the test server must tear down normally.

This is a representative LOCAL routing result. It does not establish a Temporal Cloud server's exact state, successful recovery of the accepted repair, provider lease safety, application determinism or authoritative retirement. A live guarded handoff implementation is still required; readiness checks must not apply overrides as a side effect. Before any staging handoff, verify exact current original history/run/override/pending attempts and provider leases, replay the final immutable target application bundle, bind all role versions and actual Cloud Run witnesses, persist an exclusive source-bound mutation intent and reconcile unknown acknowledgements by native reads. Keep every old worker required by any other execution until authoritative version-wide drainage and normal retirement are proved.

The observed local options update and retry completed within the fixture's original 25-second backoff window. Do not assume that changing versioning preserves a pending retry's previous delivery deadline: application/provider safety must permit the server to retry as soon as the update takes effect. This does not authorize an operator to reset attempts or call provider operations.


## Prefer the existing application continuation protocol

The immutable deployed 9094 publishing workflow already checks `targetWorkerDeploymentVersionChanged` in its review, critical-repair and cleanup loops. It uses `makeContinueAsNewFunc({ initialVersioningBehavior: 'AUTO_UPGRADE' })` while preserving the durable job reference and critical certificate or cleanup inputs. Prefer this existing application-owned transition when its next normal timer/task reaches that boundary. No new signal, options override, reset or repair submission is required for that path. The new native run is a continuation of the same durable job, not an operator-created replacement job.

[Temporal's Upgrade on Continue-as-New documentation](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning/upgrade-on-continue-as-new) describes this **Public Preview** feature: the running pinned code observes a target-version change at a Workflow Task and chooses the upgrade when continuing. Idle code does not wake just because current changed; preserve its normal timer/task and verify actual execution. Input compatibility and ready target workers remain prerequisites.

`natural-continuation-handoff.native.test.ts` proves this representative path locally with CLI 1.9.1 / Server 1.32 / SDK 1.24. An old shared pinned workflow has an existing timer, a new orchestration-only version becomes current, and the old code observes the flag and continues itself. The native continuation links to the exact old RunId, completes a Workflow Task on the new orchestration version, and executes one marker Activity on the independent role. Both histories replay. The fixture sends no signal or options update and asserts neither appears in either history. This is not actual application recovery, a Cloud Run wake test or permission to retire old versions.

A read-only staging capture on 2026-10-20 found the previously recorded original run had already continued normally. Operators must follow native continuation links and join the exact current active run with the same durable job/generation/certificate before evaluating migration; a historical RunId is not an active mutation target. The candidate production workflow bundle replayed both captured histories successfully. These private captures establish determinism at those moments only. No staging version promotion, override, provider action or retirement was performed.

If the application cannot reach a safe continuation boundary, the separately guarded exact-run override remains a possible fallback, subject to every prerequisite above. Do not implement it as an automatic readiness side effect or assume this local continuation test proves all protected workflows have drained. After a normal continuation, require actual target orchestration execution, independent role receipts, preserved certified recovery/provider identities, and authoritative version-wide drainage before retirement or WCI attachment.
