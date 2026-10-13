# Durable application workers

This service binds the real application Activities to Temporal. It does not expose
an application mutation API. Firebase admits authorized immutable intents and
writes an outbox in the same transaction; the orchestration worker dispatches
that outbox through the private Temporal connection.

Build with `pnpm --dir apps/temporal-worker build`; this compiles Activity adapters
and creates `apps/temporal-worker/lib/workflow-bundle.js`. Workflows are bundled
separately from Firebase, native executables and secrets. Start the compiled
service with the package's `start` command. The production Docker build uses
Node 22 and glibc, runs without root, and includes FFmpeg, ffprobe, yt-dlp and
Deno. Build the image with `--build-arg TEMPORAL_IMAGE_BUILD_ID=<full Git SHA>`.
The image bakes this revision into a root-owned read-only marker and OCI label;
production startup rejects a different `TEMPORAL_BUILD_ID`. Deploy by immutable
image digest linked to the reviewed Git commit and signed build provenance.

The root production dependency pins `protobufjs` to the Temporal SDK's compatible
major so the hoisted install gives `@temporalio/common` and `@temporalio/proto`
one shared schema constructor. Firebase retains its own compatible protobuf 7
dependency. Removing the root pin can break JSON history conversion even when
ordinary workflow execution succeeds. The Docker build runs
`scripts/check-temporal-history-runtime.mjs` after production dependency pruning
to catch this before publishing an image. The restart-probe test also replays
exported protobuf JSON, not just decoded SDK history objects.

Export replay files with the Temporal CLI or the SDK's `historyToJSON(history)`.
`JSON.stringify(history)` and protobufjs `history.toJSON()` use a different
representation for timestamps and are not Temporal protobuf JSON replay files.

Required configuration:

| Variable                                                                                                       | Meaning                                                                          |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| FIREBASE_PROJECT_ID                                                                                            | Canonical environment identity; must match initialized Admin SDK project         |
| TEMPORAL_NAMESPACE                                                                                             | Must exactly equal FIREBASE_PROJECT_ID                                           |
| TEMPORAL_ADDRESS                                                                                               | Private gRPC server address                                                      |
| TEMPORAL_TLS_CA_FILE / TEMPORAL_TLS_CERT_FILE / TEMPORAL_TLS_KEY_FILE                                          | Mounted mutual TLS files, mandatory in production                                |
| TEMPORAL_TLS_SERVER_NAME                                                                                       | Optional certificate DNS identity override for a Kubernetes service address      |
| TEMPORAL_DEPLOYMENT_NAME / TEMPORAL_BUILD_ID                                                                   | Stable deployment name and immutable Git commit version                          |
| TEMPORAL_WORKFLOW_BUNDLE                                                                                       | Prebuilt bundle path, already set in the image                                   |
| GOOGLE_APPLICATION_CREDENTIALS                                                                                 | Mounted environment-specific service account, or an equivalent workload identity |
| FIREBASE_STORAGE_BUCKET / FIREBASE_DATABASE_URL                                                                | Explicit project-specific storage and RTDB configuration                         |
| TEMPORAL_WORKER_POD_NAME / TEMPORAL_WORKER_POD_UID / TEMPORAL_WORKER_POD_NAMESPACE / TEMPORAL_WORKER_NODE_NAME | Downward API identities required by production orchestration workers             |
| TEMPORAL_CLUSTER_ID                                                                                            | Optional expected kube-system namespace UID; mismatch prevents startup           |

`TEMPORAL_TASK_QUEUES` selects a comma-separated subset of `urm-orchestration`,
`urm-controls`, `urm-media`, `urm-email`, `urm-images`, `urm-search`. Separate deployments should
select one queue and receive only its provider secrets. The orchestration queue
runs the outbox dispatcher by default. `TEMPORAL_DISPATCHER_ENABLED` can explicitly
control that role; admission remains available while a dispatcher is unavailable.

Production orchestration workers authenticate to the Kubernetes API using their
mounted service account and cluster CA. Startup verifies the current Pod, Node
and kube-system namespace identity; restricted GET permissions and API egress
are required. Private execution records include the process UUID, build, Pod,
Node, container and Temporal namespace identities. A drain witness is written
only after the actual Activity promise settles; a crashed worker cannot claim
its unknown external operation has drained. These identities stay out of
Workflow arguments and public job documents.

The media queue defaults to two native Activities; `TEMPORAL_MEDIA_CONCURRENCY`
sets the deployment capacity. Source/output/workspace/headroom byte limits
are configured by the corresponding `TEMPORAL_MEDIA_*_BYTES` variables. The
platform provisions per-Pod scratch storage for those reservations. Metadata,
observer and cancellation Activities use the dedicated `urm-controls` queue so long native
conversions or provider mutation waits cannot starve cancellation controls.
`TEMPORAL_CONTROLS_CONCURRENCY` defaults to ten independent Activity slots;
the controls role has no Workflow poller or outbox dispatcher.

The search queue mounts private per-instance configuration at
`TEMPORAL_SEARCH_CONFIG_FILE`; each entry contains `projectId`, `appId`,
`writeKey`, `indexName`, `collectionPath`, `fields`, `altObjectId`,
`transformFunction` and `location`. These values never enter Workflow history.
The email queue uses the migrated Trigger Email kit's existing SMTP/OAuth/SendGrid
configuration and secrets, including its sender and templates configuration.

`GET /healthz` reports process liveness. `GET /readyz` requires running Workflow
and Activity pollers, a recent successful namespace probe, and a healthy
dispatcher when enabled. SDK Prometheus metrics bind to port 9464 by default;
`TEMPORAL_METRICS_ADDRESS` overrides it. Both health and metrics ports must remain
private. `TEMPORAL_SENTRY_DSN` enables sanitized worker failure reporting.

SIGTERM stops new dispatches and polling, allows native work to abort and drain,
and closes connections. Mounted mTLS certificate changes also trigger graceful
restart so the same immutable worker version reconnects with renewed credentials.
Activities heartbeat and providers preserve private
receipts so another worker can safely resume. Do not retire a pinned worker
version while executions still depend on it. Long-lived coordinators require
an explicit version transition or termination after drain, rather than removing
old code and relying on replay to tolerate it.

Runtime unit and native Workflow tests run with `pnpm --dir apps/temporal-worker
test`. These tests do not reuse development Firebase emulators. Firebase
integration tests remain under the repository's dedicated `firebase.test.json`
harness and must be scheduled serially.

## Uncertain provider requests

A `PROVIDER_MUTATION_UNRESOLVED` or `PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED`
case keeps its original resources quarantined. `PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED`
also quarantines an original response that could not be safely recorded. The
private session and original request facts are authoritative; the public opaque
session ID locates the case without exposing requests or credentials.

An operator should:

1. Preserve the original private session, immutable intent, request fingerprint,
   execution witness, and available original response facts. Restrict access to
   administrators; never paste tokens, signed URLs, or response bodies into the
   public job or a support ticket.
2. Stop new work against the affected resource IDs. Leave cancellation pending
   and retain the session and its exclusive resource ownership. Draining or
   terminating the worker proves only that the local invocation stopped; it
   does not prove the destination discarded an accepted or delayed request.
3. Contact the destination's support team using the verified provider account,
   affected resource IDs, request time, and its original request/correlation ID
   when one is available. Ask them to investigate whether that exact request
   was accepted, queued, completed, rejected without effects, or can still be
   applied. Store the support case reference in restricted operational records.
4. Use application repair only when the source generates a certificate from
   preserved original positive completion facts and the pre-request frozen
   projection. The review rechecks the current administrator, fixed account,
   immutable request, and current destination state. It never synthesizes an
   original acknowledgement from a later matching GET or a support response.
5. If the required original proof is unavailable, leave the old resources
   quarantined. Escalate a separately reviewed migration or retirement of those
   resources; it must use distinct physical IDs and preserve the unresolved
   old ownership. There is no generic unlock, receipt deletion, TTL expiry,
   workflow termination, or retry operation that authorizes reuse.

Support evidence is useful for investigation, but this implementation has no
vendor completion-certificate protocol that can unlock an unknown request.
Adding one requires a documented, authenticated, exact-request vendor contract
and a reviewed source validator. An operator assertion alone is insufficient.
A synchronously acknowledged request with its original facts and frozen plan
can use factual canonical repair; an unknown request cannot use that path.

Canonical deletion does not remove the durable job. After the canonical root is
removed, remaining mirror cleanup requires the immutable private removal
checkpoint, the exact original provider facts, current job generation and SDK
execution, and current permission. This continuation permits only the frozen
cleanup program. It cannot authorize a new destination request or recreate the
missing root. Administrators are subject to the same source-proof requirement;
reviewed critical repair also rechecks the current administrator inside its
canonical transaction. The provider guard and usage authority remain until the
entire confirmed cleanup has settled.

Original destination responses atomically persist their private completion fact,
request state, and a coalesced metadata wakeup. `publishingEvidenceAvailable`
wakes only the private review compiler; it cannot resume a desired operation,
create a resource, or release provider ownership. The dispatcher revalidates the
current project, generation, workflow, entity owner, and exact original fact.
Stale or terminal routing drops the notification while preserving the fact.
A newer fact arriving during a dispatch lease remains pending after the older
notification is acknowledged. Review uses durable signals, bounded compiler
pages, and history rotation; an hourly fallback repairs missed notifications.

Publishing source protocol `publishing-source-catalog-v1` is authored only by
server admission. Every enrolled fixed effect descriptor and deletion journal
is registered before HTTP in its producer transaction. Sealing the source
catalog freezes both future registrations and all new desired first claims,
including claims for an existing descriptor. Each first-claim transaction reads
that same source root after exact original-ACK replay lookup. Catalogue sealing
therefore prevents an omitted future effect; it does not prove an in-flight
request completed or an SDK invocation drained. Original unknown requests
retain their quarantine. Old jobs without this producer protocol cannot gain
catalogue authority through a missing-document or empty-query shortcut.

The review catalog compiles immutable operation pages and verifies source
membership for each fixed operation beside fresh administrator and SDK fences.
Its fixed-effect scope does not replace the separate allocation receipt and
late-create orphan review mechanisms. Final canonical deletion keeps provider
ownership until its full source program, root removal, mirror pages, and count
updates are proved complete. A qualified source no-send disposition remains
separate from an original HTTP acknowledgement.

A publishing review that continues into a new workflow run saves a private,
source-validated create checkpoint. An ordinary authorized resume can load it
only after the original create receipt has been reviewed for the same intent
and generation and the original actor still has permission. Main publishing
skips only independently proven completed stages. Entity creation uses a
dedicated reviewed-create tail; it never replays the original entity handler.
A metadata evidence wakeup cannot activate either continuation. Missing or
rejected checkpoints leave the review live until an eligible review or verified
cancellation cleanup completes.

Before a certified repair changes canonical data, its SDK execution takes the
source-certified affected parent step epochs as well as its cleanup step.
Source summaries pin those IDs to the same job and certificate. Original HTTP
acknowledgements still persist independently; the step transfer prevents an old
activity from later overwriting the repaired canonical or public state.

`WorkerRestartProbe` is an operator-only deployment check with no arguments,
activities, Firebase access or provider requests. Start it on the pinned worker
queue, query `workerRestartProbe.status`, and record its returned `runId`.
After replacing the worker process, the same handle must return the same run
ID and `waiting` state. Signal `workerRestartProbe.release` to finish the probe.
This checks ordinary original-run replay after a worker restart; it does not
attest application effects or authorize disaster recovery.
