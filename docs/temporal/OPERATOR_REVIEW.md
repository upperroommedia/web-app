# Review an uncertain external result

An operation enters **Needs review** when the provider may have accepted a request but the application cannot confirm its result. Do not restart the original creation or delivery blindly. Closing a browser, retrying a network response or an empty search result does not prove that the provider performed no work.

An active administrator reviews the job's immutable intent and the connected provider's logs. The review includes a bounded evidence reference and reason. Keep credentials, signed links, recipient message content and private provider logs out of the public job, browser diagnostics and workflow history. Evidence references belong to the private resolution audit.

## Intentionally adopt an existing resource

Choose a known resource ID in the correct provider account. The server fetches that specific resource and checks compatibility with the immutable operation, including the relevant media associations. It does not discover or select resources automatically by title or date.

Select **Adopt existing resource** and explicitly acknowledge that the original uncertain request may have created an additional resource. Adoption means the administrator deliberately associates the selected compatible resource with this job. It is not proof that the original request succeeded or failed. Record why this resource is appropriate and retain any possible orphan for a separate reviewed cleanup. A shared image cannot be adopted to overwrite its bytes, even if a provider returns an upload slot. Retain uncertain allocations through cleanup review and submit a fresh owned image intent.

The server checks administrator access, job generation, projection revision, receipt state and active-attempt guards before committing the resolution. The reviewed provider receipt, resume command, job projection and completed administrator audit commit in the same database transaction. A failure cannot adopt a resource while losing its resume command. A request still executing must first pass its domain's bounded waiting period. If the job or permissions change during verification, refresh its state and review again. A lost response can be retried with the same review request ID; the same ID cannot select another resource or decision.

## Review email delivery

Use the mail provider's delivery logs and the retained private delivery receipt. The server reads the receipt attempt token privately. The browser never supplies or receives that token.

- **Confirm accepted** closes the original attempt as accepted after reviewing the provider's evidence. This does not claim that the recipient read or received the message.
- **Mark failed after review** closes the original uncertain attempt without sending another message. An uncertain original result can still have reached some recipients.
- **Resend after review** requires explicit acknowledgement that some recipients may receive a duplicate. It creates a separate durable delivery from the original frozen envelope, preserves the original attempt's audit, and returns a link to the new job. It does not erase or reopen the original receipt.

A still-sending email attempt cannot be replaced before the bounded attempt guard expires. Late workers retain receipt-token fencing, so a reviewed decision cannot be overwritten by the original worker's delayed result.

## Reconcile an uncertain account access change

Select **Confirm already applied access** only after the server can verify the exact frozen custom claims and the unique operation marker in a fresh Firebase Auth read. The server privately finds the originating execution witness; the browser supplies a review reference and reason, never execution credentials or a completion token.

The witness must show that the original worker has finished all provider work. After a claims worker crash, use the audited account-execution recovery tool to verify the exact pod, node and container identities, authenticated cluster evidence and absence from the live kubelet before recording a termination attestation. A timeout, missing pod name, expired lease or operator checkbox is not sufficient. The attestation proves that the caller cannot issue more requests; it does not prove that its remote request completed.

The role setter uses one Identity Toolkit request without mutation retries. This matters because the [Firebase Admin SDK retries some errors automatically](https://firebase.google.com/docs/reference/admin/error-handling). The supported [Identity Toolkit account update API](https://cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/update) lets the worker retain a single uncertain request under its private user-resource receipt. A receipt from an unknown multi-request transport cannot be released based on one observed marker.

Only the combination of a bound completion witness and exact positive Auth observation can confirm an uncertain request. Missing or contradictory claims keep it blocked. The review never clears the lock to replay an unknown request, grants a different role, or treats absence as evidence of failure. After confirmation, the resource receipt, source checkpoint, administrator audit and account resume command commit together. The same transaction reserves the subsequent session revocation phase. Another role change remains blocked until that phase also completes.

## Reconcile uncertain session revocation

**Confirm sessions revoked** requires the originating session execution witness, a fresh Auth read at or beyond the frozen revocation cutoff, and the exact unique session operation UUID inside the complete frozen custom claims. The worker sends that marker and cutoff together in one Identity Toolkit request. An earlier or higher cutoff without this operation marker does not prove that the uncertain request completed. Legacy unmarked requests remain blocked; the review never repeats their remote mutation. A session worker crash requires a completion witness bound to `sessionExecution`; a witness for the preceding claims activity cannot substitute for it. Follow the [account execution recovery procedure](ACCOUNT_EXECUTION_RECOVERY.md#procedure) with explicit `--phase sessions` to preview and verify that originating worker's termination, then use `--apply` only after reviewing the evidence. The tool writes the bound witness and private audit; it does not mutate Auth, release the resource lock, or replay revocation. The separate **Confirm sessions revoked** action still requires the exact positive Auth observation described above.

## Keep shared or additional resources

**Keep this resource** is an explicit disposition for the same already confirmed allocation. The server verifies the fixed resource, seals the receipt revision and intent fingerprint, and retains a permanent provider reference edge. It grants no DELETE permission and does not upgrade a previously adopted resource into exclusive ownership.

A late original acknowledgement can reveal an additional resource after another resource was selected. Review that separate acknowledgement by its opaque ID. **Keep additional resource** verifies the original immutable allocation proof and records permanent retention. **Verify it was removed** accepts only an authenticated fixed-ID absence result for that original allocation and its original provider account. It cannot substitute the currently selected resource or reset an unknown creation request. Retention alone is never proof that a transcode stopped fetching source bytes.

Shared images support retention or verified fixed-ID absence. Operator acknowledgement cannot override missing proof of references across projects or manual provider associations. Starting an irreversible desired DELETE enters a private critical phase atomically and removes cancellation capability; an already accepted cancellation prevents that phase from starting.

## Repair an irreversible operation

Once an irreversible phase begins, ordinary replay and cancellation are unavailable. The server may offer **Approve certified repair** only after deriving a fixed repair certificate from the original intent and existing effect evidence. Review its stated purpose and supply a reference and reason. The browser cannot choose resource IDs or repair operations.

Approval atomically stores the certificate, a fresh administrator grant, the audit and the dedicated repair command. The worker validates the certificate and administrator at each permitted operation. It performs only the certified fixed reads, canonical repairs or previously approved fixed cleanup; it never replays the original desired handler or creates another remote resource. An uncertain mutable provider request remains blocked unless its separate acknowledgement and canonical checkpoint prove settlement. Matching provider state or a stopped worker alone cannot release that reservation.

A certificate may instead offer permanent retention of a legacy SoundCloud track whose original owner cannot be verified. This requires an explicit retention acknowledgement, review reference and reason. The server pins the source certificate and establishes a permanent reference before detaching the local pointer. It sends no DELETE, asserts no provider absence or original ownership, and cannot settle an unknown active provider request.

## Review an additional allocation after completion

An additional authenticated provider acknowledgement creates its own review task, even when the original operation has completed. The original stays completed. Retention or verified original-account absence updates the original allocation evidence and its reference protection, then resumes only the independent review task. Each additional allocation remains separately reviewable.

## After review

Observe the server-owned job until reconciliation completes. Command acceptance is not completed publishing or confirmed mail delivery. Cancellation can itself require review when an external result remains unknown. Resolve that uncertainty and confirm cleanup before assuming a resource was removed.

Keep the original job, intent, provider receipt and administrator review audit for investigation. Private reviews live in `durableJobResolutionRequests`; provider-specific receipts retain the decision and administrator identity. A replacement delivery retains its own job and provider receipt. Automated provider side effects remain disabled during recovery from a restored database until external state has been reconciled.
