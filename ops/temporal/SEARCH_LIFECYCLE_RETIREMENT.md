# Retiring deployment-created staging search tasks

The Firebase search kit's `afterRedeploy` lifecycle hook creates an
`executeFullIndexOperation` Cloud Task even during a durable upgrade. When search
already belongs to Temporal, releasing such a task would request another backfill.
The normal drain correctly refuses to proceed while these tasks remain queued.

Use `scripts/temporal-retire-search-lifecycle.mjs` for the finite staging recovery
described here. This is a separate, committed maintenance operation using the
ordinary `_control/temporalReleaseOperation` ownership document. It does not extend
the deployment guard, advance or rewind the release, change queue states, suppress
the normal drain, run a backfill, or touch provider data.

## Preconditions and review

The runtime stays pinned to the application's compatibility commit. The operator
checkout must be a separately reviewed, clean, committed version containing this
command. Its full tracked operator closure and the application source are checked
through the existing release runtime binding. A private copied or patched guard is
not an accepted operator.

Only `urm-app-staging`, `us-central1`, a durable-upgrade release at
`compatibility-ready`, global paused admissions, all seven Temporal owners, and
paused selected domain admissions are accepted. All ten search queues must remain
paused. All thirteen queues are inventoried across every page with FULL task views.
Only five tasks, one per search instance, can be selected; any unrelated work stops
the operation. Existing legacy queues must be empty too.

Every candidate must match the actual successful deployment CLI CreateTask
request/status/response lines and their original log hash, exact task name,
creation/schedule times, HTTPS target, OIDC identity/audience, empty lifecycle body,
and FULL metadata. First/last attempts, dispatch/response counts, changed targets,
and missing provenance are refused. The historical exclusion artifact must retain
at least all sixteen existing historical task names; none can be selected.

The five original successful generation-two parent jobs, their intents/entities,
and all eight queued search-sync jobs are captured with native Firestore proofs.
Their documents and the complete queued-search set are checked in every ownership
transaction. They are never edited. These counts intentionally describe this
specific recovery; future shapes need a reviewed change rather than a permissive
fallback.

## Read-only inspection

With the normal local ADC/operator credentials and Node 22, run the command without
`--apply`. Supply:

- `--release`, the original durable-upgrade descriptor;
- `--runtime-root`, its original immutable application checkout;
- `--operator-commit`, the reviewed maintenance operator's exact commit;
- `--candidate`, the five-task candidate artifact containing exact deployment log
  paths, hashes, request/response line numbers and metadata;
- `--exclusions`, the preserved historical exclusions artifact;
- `--parents`, the actual completed original-five-parent proof;
- `--revision`, the actual current revision;
- `--output`, a new private exclusive result path.

Inspection verifies source, operator identity, project/bucket identity, parent
continuity, all queue pages, and unchanged native release authority before producing
a manifest. It performs no cloud writes. Review the resulting exact names,
provenance, protected documents and inventory. Record its raw SHA256.

## Apply and reconcile

Use the same operator checkout, descriptor, runtime, and operator commit with
`--apply --manifest PATH --manifest-sha256 SHA --operation-id UUID --output NEW_PATH`.
The candidate/exclusion/parent/revision inputs belong only to inspection; apply
accepts the frozen inspected manifest. All original source artifacts are rehashed.
Every output is opened exclusively with mode 0600 before authentication.

The operation acquires the normal release operation document with the manifest,
operator and native release identity. It records a durable per-task deletion intent
before making exactly one DELETE request. The transport has no DELETE retry.
Successful responses are followed by actual GET404. All queues are reread before
each new DELETE and after the final deletion. A final audit is committed and the
owned operation is released only after all five absences, unchanged protected
documents, unchanged release authority, and a fresh complete empty inventory.

On error, admissions remain paused and the owned operation is retained. Do not
delete its lock, substitute another operation or rerun ordinary apply. Inspect the
actual operation, intent receipts, and task GET results first. Only the same command
with `--resume`, the same operation UUID and unchanged manifest/operator binding may
reconcile it. An already-issued deletion can only be acknowledged through actual
GET404; it is never sent again. A still-present issued task requires further
investigation and stops reconciliation. Receipts distinguish a received DELETE
acknowledgement from an unobserved outcome reconciled through GET404.

After completion, run the original normal drain again with a new exclusive output.
The drain must independently observe real empty queues and pass every existing
legacy admission/lease/RTDB check. Continue normal provider continuity, worker,
ownership, backend/UI and smoke gates. A retirement receipt is not staging business
readiness.

## Validation

The two focused `node --test` suites use synthetic in-memory cloud seams. They cover
finite scope, actual log-pair parsing, complete pagination, forbidden admissions and
phase changes, protected work, existing locks, foreign tasks, lost acknowledgements,
at-most-once deletion, recovery binding and final proof failures. They do not claim
that any real Cloud Task has been retired.
