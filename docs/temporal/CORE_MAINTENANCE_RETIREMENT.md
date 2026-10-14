# Retired legacy core maintenance callables

`updatecreatedandeditedatmillis` and `fixsermoncounts` were unused, unauthenticated
bulk mutation callables. A repository-wide caller review found only their own
modules and core export wiring, with no application, script, or documented
operational caller. Their source modules and exports have been removed. The
runtime count-recalculation helper remains available to the normal application
operations that maintain counts.

The timestamp backfill read the entire collection, reused a batch after committing
it, and did not await intermediate commits. The count repair read the entire
collection and started every repair concurrently. Neither registered a tracked
admission lease or obeyed the release pause. Reintroducing these endpoints would
reopen a path around the durable release boundary. Any future repair should be a
separately designed authenticated, bounded, resumable durable maintenance operation.

Source export removal alone does not demonstrate that a previously deployed
endpoint is absent. During the guarded staging compatibility rollout, use the
Firebase CLI to retire exactly these two names from the actual deployed region:

```sh
pnpm exec firebase functions:delete updatecreatedandeditedatmillis fixsermoncounts \
  --project urm-app-staging --region us-central1 --force
pnpm exec firebase functions:list --project urm-app-staging --json
```

Before executing the deletion, confirm the live names and regions from the
inventory; use the discovered region if it differs. Preserve the CLI deletion
result and a fresh successful post-deletion inventory proving that **both** names
are absent. A missing source export, deployment plan, failed inventory request, or
HTTP status alone is insufficient evidence. Compatibility readiness must include
this live absence proof. Production retirement is part of the separately approved
production rollout, using that project's verified inventory.

Legacy invite creation now awaits its admission lease's effect acknowledgement
immediately before creating the invite. A failure after an acknowledged write
attempt, persisted invite, or queued email retains an uncertain lease for review;
it cannot be reported as a rejection with no effects. Validation remains before
the acknowledgement. The direct server delegate continues to support its existing
optional lease contract; this change does not replace durable account execution.

## Retired deletion listeners and current-state mirrors

The `sermonOnDelete` and `listondelete` exports are also retired. Their delayed
Firestore events previously called `recursiveDelete` against the current parent
path, so an event from a deleted incarnation could erase a recreated parent and
new descendants. The sermon listener additionally deleted mutable Storage paths
without generation preconditions, then cleared native queue state and could
dispatch another YouTube probe. A current parent read alone cannot make those
cross-service effects atomic with recreation.

Modern canonical deletion already owns its frozen inventory: the sermon and list
deletion mirror plans capture original rows, require source digests and provider
facts, and remove them in bounded fenced transactions. The sermon write listener
therefore also performs no deletion cleanup. It must never compete with that
inventory or sweep uncaptured descendants. Media artifact cleanup remains the
separate administrator operation: a recorded generation, no active references,
and at least 90 days since the last reference release are required. Unindexed
legacy objects are excluded and remain conservatively retained for separately
audited cleanup; deleting a sermon does not authorize deleting a same-named object.

Deploy these changes with **all admissions paused**, and retire the two actual
listener functions through Firebase CLI in their inventoried regions:

```sh
pnpm exec firebase functions:delete sermonOnDelete listondelete \
  --project urm-app-staging --region us-central1 --force
pnpm exec firebase functions:list --project urm-app-staging --json
```

Preserve the successful command result and fresh successful live inventory proving
both exact names absent before accepting compatibility readiness. This requirement
is in addition to the two maintenance callables above. Production uses its own
separately approved rollout. Legacy orphan RTDB/native requests require explicit
reviewed reconciliation. Native execution must independently verify the current
canonical admission; absence of the old cleanup listener is not authorization to
execute an orphan or to advance a deferred probe.

Sermon and list mirror updates now query bounded pages and read current canonical
state, current mirror rows, and their current parents inside each write transaction.
An older event reconciles current truth rather than reapplying its payload. Missing
canonical documents or parents never cause recreation. Transactions retry from the
new canonical revision if a concurrent update conflicts. Nested sermon list items
keep their placement fields and receive current sermon data in `mediaItem`.
Algolia acknowledgement rereads the canonical revision after polling and compares
its native Firestore update timestamp in the acknowledgement transaction, including
same-millisecond edits and delete/recreate races.
