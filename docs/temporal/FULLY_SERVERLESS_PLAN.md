# Fully serverless migration implementation plan

Status: authorized implementation and staging deployment; no production deployment. The human authorization supersedes the earlier deployment hold. Do not resize the worker VM, introduce another always-on host, or retire existing workloads until the replacement and exact handoff have been verified. Latest human scope: retain the existing Hetzner YouTube downloader/authentication for now. Defer residential proxy and home-machine replacement until the human regains access. This is an explicit exception to the serverless compute target, not a prerequisite for Temporal staging readiness.

## Target

- Temporal Cloud retains workflows/history and wakes versioned Cloud Run worker pools through its native serverless integration (Public Preview). Min instances zero, bounded max instances and explicit scale-in stabilization.
- A separate authenticated Cloud Run dispatch service uses the existing outbox leases, stable workflow IDs and unknown-ack handling. Firestore events wake it; bounded scheduled reconciliation recovers missed events, future retries and expired leases. It has no continuous polling loop and scales to zero.
- Keep one immutable pool per Temporal deployment version. Initially assess a consolidated process polling the existing six queues to preserve their common version identity; independently audit resource/egress/isolation implications. Do not change workflow deployment names or inherit activity routing blindly. Alternatives require replay/routing tests.
- Audio scratch uses explicitly provisioned ephemeral disk; preserve supported input/output budgets and bound media concurrency to actual disk capacity. Store durable inputs/results in the existing same-region bucket. No persistent disk or filesystem is an authority for completed work. Initial media design is one100GiB ephemeral volume perinstance, mediaConcurrency1, a64GiB workspace reservation plus16GiB headroom (80GiB total; source/output budgets are already inside workspace). Require actual approved perinstance/regional quota and statfs evidence before admitting media; no promised storage capacity from configuration alone.
- YouTube acquisition retains the existing Hetzner authentication and recovery service. Serverless orchestration must preserve one task authority, immutable artifact receipts and cancellation/unknown-outcome handling when invoking it. Do not assume the legacy full-processing endpoint is an acquisition-only adapter: verify the boundary before routing a Temporal activity to it. All other eligible task execution targets scale-to-zero compute. No new proxy or home-network changes in this release.
- Preserve familiar UI, authoritative status sources, provider journals, idempotency, cancellation and privacy. Existing public-only provider simulation stays staging-only.

## Primary references

- https://docs.temporal.io/serverless-workers/cloud-run
- https://docs.temporal.io/production-deployment/worker-deployments/serverless-workers/cloud-run
- https://docs.temporal.io/develop/typescript/workers/serverless-workers/cloud-run
- https://docs.cloud.google.com/run/docs/configuring/workerpools/ephemeral-disk
- https://docs.cloud.google.com/run/docs/container-contract
- https://docs.cloud.google.com/run/docs/about-instance-autoscaling
- https://github.com/yt-dlp/yt-dlp/wiki/Extractors
- https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide
- https://github.com/Brainicism/bgutil-ytdlp-pot-provider

The Reddit architecture post supplied then explicitly withdrawn by the human is excluded as evidence and as a dependency.

## Execution slices and verification boundaries

1. [ ] Dispatch: bounded invocation using existing lease/settlement logic, no application poller required at zero. Verify normal submit, duplicate events, unknown acknowledgement, scheduled retry and expired lease recovery through the existing public dispatch boundary. HTTP auth belongs to private Cloud Run IAM; validate event project and constrain body/method/path. Reconciliation must be independent of any worker being alive.
2. [ ] Runtime: authenticated Cloud Run identity/build evidence, immutable version association, graceful shutdown within platform constraints, preserve existing Kubernetes verification for retained workers. Never fake Kubernetes identity or weaken original provider/account recovery fences. Review termination attestations separately; unsupported manual recovery must fail closed. Identity assurance uses platform-injected pool/revision names plus authenticated revision GET and metadata project/service account, not cryptographic workload attestation. Reject configured overrides of platform identity names. The release/IAM layer must bind an exact dedicated per-version service account and prevent unrelated workloads from using or impersonating it.
3. [ ] YouTube compatibility: retain Hetzner acquisition/authentication/recovery, inventory its callers and verify the Temporal-to-Hetzner boundary without duplicate processing authority or public status writers. Preserve cancellation, credential privacy and actual artifact/duration receipts. Home-machine and cookie-free proxy replacement are deferred.
4. [ ] Platform: explicit worker-pool resources, min0/max cap, preview disk quota, Secret Manager mounts/service identity, scoped Temporal scaler IAM. Native readbacks must bind project/pool/revision/image/build/queues, with no VM resource evidence relabelled as Cloud Run.
5. [ ] Release: reviewed controller extension supporting worker pools and event dispatch; bind new source/full CI/image evidence and preserve normal release/provider epoch/ownership invariants. Freeze UI before staging merge. No manual release CAS, fabricated readiness, duplicate provider operations or guard bypass.
6. [ ] Local/CI: meaningful tests at dispatch, worker identity, retained YouTube invocation/cancellation, release evidence and native replay boundaries; then full exact-head CI once. Run emulator suites through dedicated firebase.test.json, serially. Review Standards and Spec before signed source commits.
7. [ ] Staging: deploy immutable resources under normal guarded release; verify zero->work->zero, timers/retries/signals waking old versions, crash/restart/provider unknown-outcome safety, long audio, authentication/privacy/search/email. No real provider/SMTP effects.
8. [ ] Native computer use: original Chrome admin session, actual new build/source binding; upload file and public YouTube, play/seek/reload, edit/publish/cancel/review and admin/ordinary views. Use emit:false and redact token URLs/private mail/credentials from all displays. Native computer use is required; CI/headless fixtures do not substitute.
9. [ ] Cleanup: only after workload/version and artifact handoff proof, prepare reviewed retirement of the staging worker VM. Retain the explicitly authorized Hetzner YouTube dependency; production Hetzner stays untouched absent separate production authorization. Document remaining disk/IP/artifact costs honestly. Inventory every staging media/download caller and identify the deliberate Hetzner YouTube exception; prove other migrated paths use their intended serverless backend. For each existing pinned build, retain its original Kubernetes workers until authoritative completion/drain, or use a separately reviewed replay-tested native migration mechanism. Existing images require Kubernetes identity and cannot simply be redeployed under the same build in a pool. Do not mutate old images, fabricate identities or reset jobs to force retirement.

## Deferred home/proxy investigation

Human requires sticky residential suitability, long-format downloads and avoiding per-GB costs where feasible. Compare flat-rate ISP/static residential (often datacenter-hosted ISP addresses) against genuine residential sticky sessions; they are not equivalent IP products. Verify session duration, Googlevideo/YouTube permission, fair-use throttling and actual invoice minimum. Do not buy a plan or expose credentials. Audio-only at128kbps is about57.6MB/hour before overhead/retries; at256kbps about115.2MB/hour. Full-video bandwidth is unnecessary for the audio flow. Google inbound bytes and same-region storage transfer must be distinguished from proxy billable traffic, logs, storage, compute and outgoing user downloads.

Deferred: no live proxy account or home-machine availability is required for the current Temporal serverless release. If resumed later, require a real media-byte canary; do not claim cookie-free success from mocks or repeat earlier account/access questions.

Latest prior-chat readback: the earlier home-PC investigation found two rebooting watchdog configurations and recorded their removal. A Realtek Ethernet/network fault remained possible; sleep was not established. BIOS update completion was not confirmed. Preserve that distinction when resuming home work. The earlier Hetzner chats confirmed browser authentication, media-byte canaries and deferred-queue recovery; these are historical results, not fresh staging proof.
