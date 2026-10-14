# Native media ingress and legacy settling

Temporal media activities invoke the native implementation directly through the
worker's private admitted job reference. They do not invoke `/process-audio` or
create legacy Cloud Tasks. The HTTP endpoint exists only for bounded legacy work.

The HTTP handler requires a Google-signed OIDC token with an exact configured
audience and an explicitly allowed, verified service-account email. Cloud Run also
retains its IAM invoker check. A Cloud Tasks header alone is never authentication.
Before effects, the handler requires the exact server-owned RTDB queued task,
payload and request version, the immutable `legacyMediaAdmissions` and
`legacyMediaTasks` proofs, and the same canonical sermon creation timestamp.
Missing, deleted, recreated or durably owned sermons reject without processing.

New admission proofs are created in a transaction while legacy admission is open.
A verified initial source trigger may continue its canonical pre-cutoff source
using its actual active source-admission lease. Proof timestamps come from
Firestore, never the historical RTDB date strings. Retries preserve the original
proof; dispatching another task cannot renew admission or the settling deadline.
The grace ends admission of untracked continuations. Two immutable original
admissions remain runnable while the same canonical incarnation is `PENDING` or
`PROCESSING`: a protected server task proof created before cutoff, or a typed
original source whose canonical row was created before cutoff. Both require exact
uploader and source/trim selection; an older proof missing those facts requires
explicit reconciliation. Terminal rows cannot replay this authority. The final
control transaction checks pending/processing rows and active/uncertain leases, so
these originals cannot race an ownership handoff.

Original source authority lives in `legacyMediaSourceAdmissions`; storage bindings
live in `legacyMediaTaskSourceAdmissions`. These private records never renew or
replace the original admission. For the old file flow, bytes completed before the
browser created its canonical row. A delayed source event therefore requires the
configured bucket, exact owned path, immutable generation and actual object
`timeCreated` no later than canonical native `createTime`. A later overwrite
rejects. An already accepted task can capture missing object identity only if
object creation predates its protected task proof's native creation timestamp.
The SDK generation selector pins original reads; output writes and post-trim
reads use the ordinary output bucket even when source and output share a processed
path. Unsafe generation numbers that the current SDK would round reject.

Both native execution and legacy dispatch use the existing strict
`legacyAdmissionLeases` collection and record shape. The release controller sees
active and uncertain executions, and cannot take ownership over them. The
compatibility cutoff, matching release checkpoint and grace are checked using
Firestore's native timestamps and actual server read time. Failures with uncertain
effects remain `needs_attention`; no process steals leases by expiry.

Native startup does not clear shared locks, progress, queue records or sermon
statuses. Existing task retries respect the sermon mutex. Historical abandoned
records require the audited operator reconciliation tools. Cookie status is a
read-only operation. Admin cookie uploads use the typed credential-setup lease
under either open owner; uploads do not enqueue legacy probes. Existing verified
canary recovery resumes only an actual admitted legacy request, while Temporal
activities retain their separate recovery path.

## Required deployment configuration

Set these nonsecret repository variables only after observing the real callers:

- `STAGING_PROCESS_AUDIO_ALLOWED_CALLER_EMAILS` and
  `PRODUCTION_PROCESS_AUDIO_ALLOWED_CALLER_EMAILS`: JSON arrays of exact permitted
  service-account emails. Include the actual Functions runtime/Cloud Tasks OIDC
  identities and the native runtime identity if it creates retries. Do not add
  Google user emails or all service accounts in a project.
- `STAGING_PROCESS_AUDIO_OIDC_AUDIENCES` and
  `PRODUCTION_PROCESS_AUDIO_OIDC_AUDIENCES`: JSON arrays containing the exact Cloud
  Run service base URL and its `/process-audio` target URL. Firebase Admin's queue
  client uses the target URL as its default audience. The deployment adds these
  exact audiences to Cloud Run and passes them to the application verifier.

The Hetzner deployment pins audiences to its environment's public origin and
`/process-audio` path. It derives `PROCESS_AUDIO_TASK_SERVICE_ACCOUNT_EMAIL` from
its existing ADC service account without exporting credential material. Its raw
Cloud Tasks REST requests now include an explicit OIDC token configuration.
Verify that this identity is permitted to act as the selected task identity and
that the Cloud Tasks service agent can mint its ID tokens; verify Cloud Run
invoker membership for actual task callers. Never broaden an IAM grant merely to
make a probe pass. Deployment scripts reject missing or malformed configuration.
The workflow wiring does not enable a disabled workflow or bypass a release lock.

Before production promotion, inventory active requests and all pending legacy
queues again. A historical RTDB request without a server admission/task proof
fails closed. Do not backfill its authority from client clock strings. Review and
reconcile any genuine old admitted execution explicitly before pausing production.
Staging's five absent-sermon queued records remain a separate audited cleanup.

References:

- [Cloud Tasks HTTP target authentication](https://cloud.google.com/tasks/docs/creating-http-target-tasks)
- [Cloud Run custom audiences](https://cloud.google.com/run/docs/configuring/custom-audiences)
- [Verify Google ID tokens](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
