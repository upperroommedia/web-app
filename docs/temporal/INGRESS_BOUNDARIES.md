# Admission and continuation boundaries

New durable work is admitted transactionally against the release control document. A paused release rejects new work; existing admitted work has a separate continuation contract. A successful HTTP response, an authenticated administrator, or a queued RTDB record alone is not evidence of admission.

## Browser writes

Canonical account and task projections are server-authored. Browser Firestore and Storage access is limited to the explicitly supported paths in the deployed rules; there is no general upload permission for arbitrary object paths.

An admitted audio source transfer may finish while admission is paused. Its Storage path, uploader, job kind, and reservation must agree. Immutable image sources and speaker-request attachments are bounded uploads before their corresponding admission; starting those uploads requires the relevant domain to be open. They do not authorize provider work or canonical mutations.

## Synchronous administrator credential setup

SoundCloud consent exchanges and YouTube cookie setup are administrative credential operations. They use a strict operation-to-domain allowlist, require an administrator, and register a drain-visible lease atomically with the release check. They may run with either domain owner when admission is open. They do not grant permission to enqueue legacy media work under Temporal ownership.

An OAuth authorization code is a one-time grant. Claiming a callback precedes the provider request; saving credentials and consuming that claim use a matching transaction. An uncertain exchange requires fresh consent rather than replaying the same code. See [credential setup](INTEGRATION_SETUP.md).

Staging administrator bootstrap requires a verified allowlisted email address. Unverified email/password registration does not establish ownership of that address. Sign-in for other identities remains available during migration.

## Legacy effects

Retained legacy entrypoints use leases that remain visible to release drain through completion. The first effect follows an awaited effects acknowledgement. Failed work after that acknowledgement is uncertain; diagnostic lease expiry does not make it safe to replay or declare drained.

Legacy email deliveries record the SMTP submission boundary before transport. A lost response or an expired processing claim after submission remains uncertain even when the delivery displays an error. Both drain checks retain those deliveries for explicit review; neither automatically resends them.

After the compatibility cutoff, previously untracked continuation claims must fall within the reviewed grace period, using Firestore's server read time. Work already accepted before the cutoff can finish even if its first execution is delayed beyond that period. That exception requires the original server-created mail, canonical source, or protected task admission and its matching identity and generation; a queue record or client timestamp cannot establish it. Existing admitted callbacks and owned SMTP deliveries can also finish. The final drain transaction checks leases, mail, pending source admissions, and private series continuation records together with the control revision change, so a concurrent claim cannot escape the drain observation.

Provider listeners additionally bind event identity and canonical generation. A persistent uncertain effect blocks automatic replay. These checks cooperate with the release pause and drain; they do not make Firestore and provider transport one atomic transaction.

Cached bundle delivery is read-only. Legacy cache generation and listener work hold an admission lease throughout their mutation lifetime. Paused fresh events retry, and the initial Temporal cutover still bootstraps and verifies all six bundle configurations.

Mirror listeners reconcile bounded pages from current canonical documents. Reordered events cannot restore stale provider fields or recreate an absent parent. Durable deletion owns its frozen mirror inventory and artifact retention; duplicate cleanup triggers are retired.

## Deployment requirements

Removing an export does not prove the deployed endpoint disappeared. During a paused compatibility deployment, explicitly retire and inventory the obsolete endpoints documented in [core retirement](CORE_MAINTENANCE_RETIREMENT.md), [image migration](IMAGE_SEARCH.md), and [credential setup](INTEGRATION_SETUP.md). Keep production retirement separate from staging rollout approval.

Compatibility evidence must cover every exported ingress and distinguish read-only routes, fresh admissions, credential setup, and admitted continuations. A single denied callable or Storage request cannot establish coverage of all ingress paths. Preserve actual source, rules, runtime, browser, and queue evidence separately before recording the aggregate result.
