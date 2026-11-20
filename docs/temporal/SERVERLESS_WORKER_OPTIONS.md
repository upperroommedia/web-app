# Temporal worker hosting options

Research date: October 19, 2026 (America/Los_Angeles). Research only; no deployment approval or implementation. The human subsequently authorized a fully serverless implementation, testing and staging deployment followed by native computer-use retesting; see FULLY_SERVERLESS_PLAN.md. No production changes are authorized.

## Finding and recommendation

Use Temporal Serverless Workers on Google Cloud Run as the leading architecture candidate. The current canonical documentation marks the integration Public Preview; Temporal’s official changelog lists the preview on October 5, 2026. [Temporal Cloud changelog](https://temporal.io/changelog/product-area/cloud). Temporal controls worker-pool instances in response to queued work, including waking from zero. This differs from putting an ordinary poller in an HTTP Cloud Run service. [Temporal overview](https://docs.temporal.io/serverless-workers), [Google announcement, October 15](https://cloud.google.com/blog/products/serverless/temporal-serverless-workers-on-cloud-run-worker-pools).

This is a recommendation to design and validate, not a finding that the present image can be redeployed unchanged. Preview acceptance, account/region/quota compatibility, scale-in safety and our application-specific changes remain unresolved. No benchmark or cost estimate has been performed.

## Options

| Option | Can idle worker compute reach zero? | Assessment |
| --- | --- | --- |
| Temporal-managed Cloud Run worker pools | Yes, including automatic wake when tasks arrive | Preferred candidate; native integration, Public Preview |
| Ordinary Cloud Run service | Yes for HTTP workloads; Temporal polling does not independently wake a zero-instance service | Requires a custom reliable wake/reconciliation design; avoid when native integration fits |
| Cloud Run Jobs for bounded execution | No idle execution between runs | Useful for audio or bounded dispatch; custom invocation/completion integration, not a direct Temporal worker autoscaler |
| Kubernetes with KEDA | Worker replicas can reach zero | Keeps Kubernetes/autoscaler infrastructure; does not meet the desired removal of a dedicated host by itself |
| Temporal Serverless Workers on AWS Lambda | Native serverless option | Poor fit for this GCP-hosted namespace and current long audio activities; not the first choice |

Google documents that ordinary services need an incoming request to wake from zero, even with instance-based billing. [Cloud Run autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling).

Jobs are explicitly executed, and their task timeout can reach seven days. Treat invoking a bounded audio job from a Temporal Activity with asynchronous completion or durable execution polling as an architectural proposal requiring implementation, not automatic interoperability. [Jobs execution](https://docs.cloud.google.com/run/docs/execute/jobs), [task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout).

KEDA offers a Temporal queue scaler, but its docs warn that backlog-only decisions can mishandle in-flight work. [KEDA Temporal scaler](https://keda.sh/docs/2.18/scalers/temporal/). Lambda limits individual execution to fifteen minutes, while this app configures two-hour audio activities. [Temporal Lambda](https://docs.temporal.io/serverless-workers/aws-lambda).

## What the native integration requires

The setup guide requires a GCP-hosted Temporal Cloud namespace, versioned workers, Cloud Run/Artifact Registry and scoped IAM allowing Temporal to manage the pool. TypeScript uses standard worker code; our existing versioned Worker.create setup is a useful starting point. SDK compatibility still needs a real check. [Deployment prerequisites and IAM](https://docs.temporal.io/production-deployment/worker-deployments/serverless-workers/cloud-run), [TypeScript guide](https://docs.temporal.io/develop/typescript/workers/serverless-workers/cloud-run).

Use an immutable pool per worker deployment version. Older pools can remain configured at zero and wake for pinned work. Do not mutate a live version’s image. The docs discourage mixing long-lived workers and a pool on the same task queue: the scaler can duplicate capacity. Scale-in can interrupt an activity, so heartbeats, durable progress and safe retries need verification. [Cloud Run lifecycle and versioning](https://docs.temporal.io/serverless-workers/cloud-run).

Scale-to-zero means no continuously running worker instance when idle; it does not mean zero Temporal, storage, image, logging or event-delivery costs. Frequent timers or reconciliation can still wake workers.

## Application-specific changes found in current source

These are source inspection findings on PR256 head 165b5e399d5475f9837951db6cf42582d05b1db0, not live cloud validation.

1. **Dispatch must work while workers are at zero.** `apps/temporal-worker/src/runtime/dispatcher.ts` polls the Firestore outbox every second. `src/index.ts` starts that loop inside the orchestration worker. Temporal cannot wake a worker for a task that has not yet been submitted. Move dispatch to an event-driven serverless handler with durable lease/idempotency semantics and bounded reconciliation. An event trigger alone must not lose retries or lease-expiry recovery.
2. **Replace Kubernetes-specific identity and release evidence.** `src/runtime/worker-witness.ts` obtains pod/node/cluster identities; production orchestration requires it. `functions/src/temporal/domainResolver.ts` validates those fields. Implement authentic Cloud Run identity/build evidence and corresponding reviewed guards; do not disable them or invent Kubernetes values.
3. **Separate resource profiles and version routing deliberately.** Six role processes currently share a deployment/build identity. The native integration assigns a pool to a deployment version. Determine whether to split deployment identities by role/resource class or consolidate compatible queues; prove activity routing and pinned-history compatibility before rollout.
4. **Audio storage is substantial.** `apps/process-audio/src/temporal/resources.ts` defaults to 20 GiB source, 20 GiB output, 64 GiB workspace plus 16 GiB headroom per reservation. `apps/temporal-worker/src/workflows/media/index.ts` allows two-hour processing. This cannot be assumed to fit the normal memory-backed filesystem. Cloud Run worker pools offer Preview ephemeral disks, 1–100 GiB per volume, with a default 10 GiB per-instance quota. Larger allocations require quota approval. Scratch disappears with an instance, so durable artifacts and restart behavior need testing. [Worker-pool ephemeral disk](https://docs.cloud.google.com/run/docs/configuring/workerpools/ephemeral-disk).
5. **Shutdown and provider safety need real tests.** Current worker grace is two minutes; Cloud Run documents a ten-second shutdown window. Confirm interruption behavior, duplicate suppression and acknowledged provider outcomes; a heartbeat alone does not make an external operation idempotent. [Container contract](https://docs.cloud.google.com/run/docs/container-contract).

## Before any deployment

Prepare an implementation design and cost model with bounded maximum instances, explicit scale-to-zero settings, IAM, media storage and dispatch recovery. Then run isolated cold-start, wake-from-zero, timer/retry wake, scale-in interruption and old-version/pinned-workflow tests. Preserve the current held jobs and provider journals throughout. Only after a reviewed handoff and verified artifact recovery may the VM and its disks be considered for retirement. Do not stop/delete it merely because the target architecture is serverless.

The prior capacity question and additive-VM rollout plan are superseded by this hosting review. PR256 CI remains useful for its exact source; it does not validate a future hosting change.
