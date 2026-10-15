# Staging search onboarding

This is a separate staging-only initial cutover after the six-domain release has
reached `complete`. It uses the existing global admission pause and real legacy
execution grace. It does not transfer the other six domains back to legacy or
create a new controller mode. Actual rollout, secrets and provider writes require
an operator-reviewed release; repository tests are not a deployment receipt.

The reviewed target is Firebase `urm-app-staging`, Algolia application
`2VZFOFLFHE` in US Central, and the five instances in
`packages/contracts/staging-search.json`. Production's application and keys are
outside this operation. The observed initial collection counts imply 7,364 records
with the six configured standard replicas, below the reviewed Free allowance of
50,000 records. Recount before applying; the Free plan also has a monthly search
allowance. No additional VM is prescribed: the sixth search deployment uses the
existing staging worker VM, one replica, a 100m CPU/256Mi request, 1 CPU/512Mi limit
and two concurrent activities. Confirm actual remaining host capacity and account
usage before release.

The provider-resource index remains on its original verified epoch. During the
search freeze, the controller captures continuity from the actual previous
`complete` checkpoint and ready index, including the marker body hash and native
create/update versions. Search does not acquire provider-bearing domain ownership,
so `provider-usage-ready` validates that retained index instead of invoking the
legacy-only provider backfill. It does not change the marker's origin release or
epoch. The provider-ready, ownership and open transactions recheck the archived
predecessor, unchanged marker, six existing owners and drained non-search work.
Missing, building, replaced or inconsistent continuity blocks the release.

The new freeze replaces the control/checkpoint with a new release, without copying
the previous release's legacy cutoff. `compatibility-ready` stamps a new native
server cutoff and full reviewed grace for search. The previous cutoff remains in
archived predecessor evidence; it cannot shorten the new grace.

## Private credentials

Use the official signed-in Algolia CLI with explicit `--application-id 2VZFOFLFHE`
on every account command. This account intentionally has no default application.
After any environment loader, unset inherited `ALGOLIA_API_KEY`,
`ALGOLIA_ADMIN_API_KEY`, `ALGOLIA_APPLICATION_ID`, `ALGOLIA_APP_ID` and
`ALGOLIA_PROFILE` before using the CLI's OAuth credential store. Never print keys
or fall back to production environment values.

Create separate credentials with these ACLs and exact index allowlists:

| Credential                      | ACL                                      | Exact indices                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| speakers worker                 | `addObject,deleteObject`                 | `speakers`                                                                                                                                                                           |
| sermons worker                  | `addObject,deleteObject`                 | `sermons`                                                                                                                                                                            |
| images worker                   | `addObject,deleteObject`                 | `images`                                                                                                                                                                             |
| lists worker                    | `addObject,deleteObject`                 | `lists`                                                                                                                                                                              |
| users configuration placeholder | `search`                                 | `users`                                                                                                                                                                              |
| private signing parent          | `search`                                 | `sermons,speakers,speakers_sort_name_asc,speakers_sort_name_desc,speakers_sort_sermonCount_asc,speakers_sort_sermonCount_desc,lists,lists_sort_name_asc,lists_sort_name_desc,images` |
| separate settings initializer   | `settings,editSettings,addObject,search` | All ten browser indices above plus `users`                                                                                                                                           |

`addObject` also authorizes task-status confirmation. Runtime worker keys do not
need settings, browse, key-management, wildcard, replica or cross-index access.
The users credential is never given to a browser; `empty-private` skips every
users record and independently rejects extraction. The settings credential may
check that an existing users index is empty, then initialize settings. It never
indexes users, deletes records, deletes indices or silently detaches replicas.

Populate the five per-instance Firebase `ALGOLIA_API_KEY` secret bindings with the
corresponding restricted keys. Populate the private worker map from
`ops/temporal/staging-search-instances.example.json` and mount it as
`TEMPORAL_SEARCH_CONFIG_FILE`; the runtime rejects a missing, foreign, altered or
world-readable map. The private Functions `ALGOLIA_SEARCH_API_KEY` is the signing
parent. Remove public-parent bindings from App Hosting and rotate any parent
previously exposed to browsers. The application ID is public; the parent key is
not. App Hosting secrets and Functions secrets have separate bindings.

Staging key issuance also reads the private release control and
`_control/temporalSearchReadiness` together in a read-only transaction. Only the
successful controller `search-ready` transaction writes that marker, bound to the
exact application, canonical record-schema hash, release, revision and five job
proofs. Missing, malformed or foreign readiness prevents constructing any provider
client, even if an unrelated UI rollout compiled search as enabled. The marker
survives later non-search releases while ownership stays Temporal; a changed
record schema requires an explicitly reviewed bootstrap/migration and fresh marker.
The schema-sync utility verifies the callable's pinned schema hash too.

Every browser role obtains short-lived keys through the authenticated callable.
The server reads current Auth roles and revocation state, ignores caller-supplied
UID/role, and issues five-minute index-scoped keys. Admin sermon keys allow all
sermons; uploader/publisher sermon keys require the authenticated uploader ID.
Shared metadata has a separate exact-index key, excluding sermons and users.
Role revocation stops new keys immediately; already-issued Algolia keys remain
valid for at most five minutes unless the private parent is rotated. UI search
refreshes credentials and clears clients on logout, account change and failure.

## Residual queue review

The earlier six-domain release intentionally excluded staging search queues. That
is not evidence that every retained queue is empty. Before the search drain,
classify every actual queued task, including the retained paused
`kit-images-index-executeFullIndexOperation` initializer-shaped task whose old
handler is absent. Payload shape alone does not prove its installer or caller. Preserve its exact identity, origin, body/metadata hashes and queue state
in a private audit. An initializer cannot be called completed merely because its
handler returns 404, and its queue must not be resumed to obtain a clean drain.

Only an explicitly reviewed exact-task retirement or a proven replacement durable
intent may resolve such an obsolete task. Record actual before/after evidence;
recount discovered queues afterward. The search-selected controller includes
these queues and must continue to reject nonempty or uncertain task inventories.
Do not add a source exception, skip validation or describe the old search-queue
exclusion as proof that the new release is drained.

## Release sequence

1. Finish the existing six-domain release and its smoke testing. Confirm all six
   owners are Temporal/open by domain and search is still legacy/paused. Confirm
   no unrelated durable work remains active before the search bootstrap.
2. Build and test the exact new candidate commit, including the sixth worker.
   Prepare a **new** UUID and private descriptor with `mode: initial-cutover`,
   `domains: ["search"]`, exact compatibility/UI commits, reviewed platform and
   peer descriptors, evidence paths, and a concrete `searchSettingsEvidence` path.
   Keep the normal reviewed grace of at least 3,600 seconds. Never reuse the
   previous release's cutoff, UUID, revision, or proof files.
3. Run `freeze-ui` through `scripts/temporal-release.mjs --release <descriptor>`
   **before merging the candidate to staging**, because its compiled staging UI
   flag enables search. Verify automatic App Hosting rollout is frozen. The
   controller globally pauses admissions while preserving the other six owners
   and their domain admission settings. Merge only after the freeze and normal CI
   review. No manual Firestore control writes are part of this procedure.
4. Deploy the reviewed compatibility code, rules and five search kit instances
   under the normal guarded `ui-frozen` operation. Existing broad deployments
   deliberately retain `--without-search`; use generated `--only-search` config
   and explicit `--include-staging-search --release <descriptor>` environment
   materialization for these five instances. `STAGING_TEMPORAL_SEARCH_ONLY=true`
   holds all staging legacy index effects even when compatibility flags still
   say legacy. `DO_FULL_INDEXING=false` makes the handler skip full-index effects;
   deployment hooks can still enqueue lifecycle tasks. Keep the queues paused,
   inventory all five queues again after deployment, and review each new task
   separately from the retained legacy task. Do not activate old extension reindex
   queues or treat deployment success as proof of an empty queue.
5. Run `compatibility-ready` with actual fresh compatibility evidence; let the
   server-stamped grace elapse. Run the existing legacy drain, worker rollout and
   provider-usage steps described in `OPERATIONS.md`, then `take-ownership`.
   Only search changes owner. Admission remains globally paused.
6. Materialize from actual current control and redeploy affected backends under
   the `ownership-changed` guard, including the private parent-key callable and
   all five Temporal search kit flags. Deploy the sixth worker with its exact
   private map and verify the actual `urm-search` queue/build witness. Run
   `backend-ready` only with fresh complete runtime/deployment evidence. The
   manual `deploy-search-candidate` workflow is an explicitly scoped alternative
   for the ownership-changed kit step; it requires the private descriptor to be
   available on that runner. It does not replace compatibility deployment or
   grant an arbitrary repository path operational authority.
7. With the separate private settings credential, run the guarded initializer
   for the exact target and save its successful JSON stdout at the descriptor's
   `searchSettingsEvidence` path. Use a private regular file, not a symlink.

   ```sh
   node scripts/configure-algolia-staging-search.mjs \
     --project urm-app-staging --app 2VZFOFLFHE \
     --indices users,speakers,sermons,images,lists --apply
   ```

   The initializer awaits all eleven settings tasks. Its completion receipt must
   be less than one hour old when bootstrap completes. Dry runs, partial failures
   or unawaited task IDs do not qualify. A failure can leave preceding settings
   applied; inspect and retry the same explicit plan without deleting indices.

8. Run controller action `bootstrap-search`. It owns its operation lock, submits
   five deterministic durable backfills and waits for current-generation success.
   Retrying reuses the same job IDs/generations. It validates settings, every
   actual intent/entity/job, and all admitted live search work. Current failed or
   cancelled synchronization requires a newer verified successful generation;
   it cannot be treated as success. Overflow or uncertain outcomes leave the
   release paused. Trusted staged document events can be captured durably during
   the pause; HTTP/task inputs cannot use that continuation capability.
9. Only `search-ready` permits `rollout-ui`. The controller repeats actual search
   convergence and release/operation checks before saving rollout identity, when
   recording UI readiness, and in the transaction that opens admissions. Use the
   existing immutable App Hosting rollout reconciliation. Pausing at search-ready
   and resuming returns to backend-ready and requires a fresh bootstrap check.
10. While globally paused, verify real UI rendering, scoped provider searches,
    no parent key in compiled/browser assets, empty/private users, projections,
    sorting, attribution, restricted-role isolation, token refresh/revocation,
    actual worker receipts and unchanged other-domain ownership. Save honest
    closed-admission evidence, run `open`, then `restore-auto` after acceptance.
    Perform real post-open create/update/delete indexing checks and signed-in
    Chrome performance analysis. Confirm eventual provider task completion and
    user-visible results, including a retry/worker restart. Obtain the user's
    staging smoke-test approval before any production promotion.

Bootstrap proves a complete source backfill and convergence of **delivered,
admitted** search events at the checked boundaries. Firestore events awaiting
Eventarc delivery are not visible as durable jobs; this is not a claim of
instantaneous source/index equality or zero propagation delay. Global write
fencing, prior-work drain, current-source convergence and durable event retries
bound that gap. Live create/edit/delete propagation must be tested after opening.
Keep normal provider failure alerts and queue latency monitoring active.

## Source and local validation

The canonical schema is mirrored into the standalone kit; run
`node scripts/sync-algolia-staging-schema.mjs --check`. Settings and explicit target
checks are covered by `scripts/algolia-staging-search.test.mjs`. Bootstrap and
controller gates are covered by `scripts/temporal-bootstrap-search.test.mjs` and
`scripts/temporal-release.test.mjs`. The real Firestore transaction suite and
serial dedicated emulator command are in `scripts/integration/README.md`.

Local tests do not create provider indices, install real credentials, deploy a
worker, prove Free-plan usage, or constitute an accepted staging smoke test.

Release CLI commands close only the SDK app created by that invocation, after the
action and its own operation-lock cleanup finish. Cleanup takes the local RTDB
client offline, terminates its Firestore client and deletes that owned app; it
does not stop Temporal workers or admitted jobs. Caller-owned/reused SDK apps are
not closed. Cleanup failure remains an error, and a preceding action error remains
primary. If process exit or teardown is uncertain, inspect the actual checkpoint
and operation before deciding whether the action needs a retry.
