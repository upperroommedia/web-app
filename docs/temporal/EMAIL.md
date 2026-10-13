# Durable email delivery

Email delivery uses `email.deliver` jobs. Workflow input and activity results contain job/project references and bounded outcome codes only. The immutable original message and frozen rendered template/recipient options live in private Firestore records. SMTP passwords, OAuth refresh tokens, API keys, body text, recipient addresses, and raw transport exceptions never enter Temporal history or the public job projection.

The worker binds the actual migrated Trigger Email adapter in `function-kits/firestore-send-email/src/temporal/runtime.ts`. It reuses the existing template and user-ID recipient resolution, SMTP credential/TLS/timeouts, OAuth, and SendGrid transport implementations. Workers are bound to one project/mail configuration; a configuration or credential rotation restarts the worker. The Cloud Functions ingress remains in legacy mode unless `TASK_ORCHESTRATOR_EMAILS=temporal` is configured. Existing `PROCESSING`, `SUCCESS`, and `ERROR` legacy messages are not silently adopted. Drain legacy processing leases before enabling Temporal; inspect expired leases instead of assuming they were unsent.

## Delivery safety

A project/job-scoped deterministic RFC Message-ID assists provider investigation. It is not a deduplication guarantee: SMTP and SendGrid do not promise to reject repeat Message-IDs.

The activity resolves templates and recipients once, stores that private prepared envelope, verifies SMTP connectivity, then transactionally writes a `sending` receipt before calling `sendMail`. Recovery observing `sending` or `unknown` stops automatic delivery and projects `needs_attention`. A provider acceptance followed by a crash before receipt persistence is therefore investigated rather than blindly resent.

| Outcome                                                                              | Behavior                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Provider confirms all recipients                                                     | Receipt accepted, legacy `mail.delivery.state=SUCCESS`, job succeeded |
| SMTP verification or proven pre-envelope failure                                     | Safe bounded automatic retries; same frozen envelope                  |
| Invalid payload                                                                      | No provider call; sanitized failure                                   |
| Provider rejects all recipients                                                      | Failed; no automatic loop                                             |
| Provider partially accepts recipients                                                | Review; do not resend to accepted recipients                          |
| DATA timeout, connection loss after submission, worker crash after the sending fence | Acceptance unknown; operator review required                          |

The receipt transaction also maintains existing `mail.delivery` state, attempts, timestamps, Message-ID, and provider info. Attachment security applies to both the legacy and durable sender: provider libraries cannot fetch URLs or read worker files. Attachments must already contain inline bytes/text, capped at 256 KiB aggregate; the serialized private envelope is capped at 512 KiB. External files must be snapshotted before queueing. Caller headers cannot override the deterministic durable Message-ID.

Cancellation remains available until the receipt's sending fence. The fence checks the job cancellation and entity generation in the same transaction and removes cancellation availability before making the provider call. Private receipts must be denied to every client in Firestore rules. Public projections include no addresses or content. Notification producers use deterministic mail document IDs, so replay of an escalation or terminal notification cannot enqueue a second mail intent.

The administrator review flow requires a provider log/ticket reference and a written reason. It fences the current job revision, generation/entity head, and private receipt token; a still-sending receipt cannot be reviewed until five minutes beyond its start. Operators may confirm acceptance after reviewing evidence, close the delivery as failed after review, or deliberately resend with explicit duplicate-risk acknowledgment. Human review is recorded as such; SMTP cannot supply a general authoritative automated lookup by Message-ID.

A reviewed resend preserves the frozen recipients/template, creates a distinct mail document and durable job/outbox in the same receipt transaction, and retains the old private receipt and audit trail. The original job closes after the worker observes the reviewed receipt. A generic Retry button never resets an unknown or partially accepted receipt. A delivery whose unsubmitted mail document expired or was deleted is cancelled; deletion does not prevent review of an already ambiguous private receipt.

SMTP connectivity retries are bounded by twelve durable timers, then expose a Resume action after the provider is repaired. Private storage failures use sanitized retryable Activity failures and keep retrying while the backing infrastructure recovers. These storage retries remain safe because every activity execution reads the receipt fence before any provider send.

## Rollout and verification

1. Deploy receipt security rules and the disabled ingress/worker release.
2. Configure the worker with the same project-scoped SMTP/OAuth/SendGrid and mail/template settings as the migrated kit; keep secrets out of environment files checked into Git.
3. Drain legacy processing leases and inspect ambiguous expired deliveries.
4. Enable the project-specific mail cutover flag and verify a dedicated test recipient through an explicitly authorized integration test.
5. Confirm the mail delivery projection and private receipt agree. Re-run an already completed job and demonstrate it does not send again.
6. Exercise worker termination immediately before/after submission in a local SMTP harness; ambiguous receipts must remain blocked for review.

Tests in `function-kits/firestore-send-email/test/temporal/` exercise receipts, crash recovery, frozen envelopes, safe pre-submission retries, partial acceptance, and sensitive-error suppression without sending real email.

This safety model follows [Temporal's Activity idempotency guidance](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/activities/activity-definition.mdx) and [Activity timeout/retry options](https://typescript.temporal.io/api/interfaces/common.ActivityOptions/). Temporal durably schedules retries; the application still owns proof that repeating an external side effect is safe.

## Controlled ownership and provider egress

The standalone ingress reads `_control/temporalRelease` inside the admission transaction. Missing or paused Temporal ownership rejects new mail; a private canonical parent intent/job proves an already admitted notification may continue during a pause. Parent references are written by trusted notification activities, never by clients. The legacy sender reads the same owner before claiming delivery and immediately before preparing SMTP, so an old environment flag cannot reopen a retired sender.

`scanLegacyEmailDrain` reads only delivery state, attempts, lease time, and ownership. It uses a stable read-only snapshot and checks the paused control revision/release identity before and after scanning. Pending messages with zero attempts may be explicitly imported while that revision remains paused. Previous-attempt retries and expired processing leases require investigation and never become automatic durable sends. Cross-domain release checks must also drain admitted producers that can create child notifications.

Email workers load `/run/email/egress.json` via `EMAIL_EGRESS_DESCRIPTOR_PATH`. SMTP and SendGrid API host/port/TLS must match the actual configured transport. Every DNS answer must be in the reviewed literal address set; drift fails closed. SMTP connects to a reviewed address while checking the certificate against the original hostname. Implicit TLS or mandatory STARTTLS uses TLS 1.2 or newer with certificate verification. OAuth additionally requires a reviewed canonical Google token endpoint and its scoped network allowance.

The no-send canary uses the same transport: SMTP verifies authenticated TLS connectivity, while SendGrid performs authenticated `GET /v3/scopes` and checks `mail.send`. SMTP verification does not establish sender/recipient acceptance, so its `mailPermissionVerified` proof is false. No message is sent. Each SMTP activity uses its own connection; verifying another job cannot close an in-flight DATA transmission. The private execution fence is checked again after endpoint resolution and before transmission.

SMTP effects use `urm-email`; metadata, retry escalation and reviewed receipt finalization use the datastore-only `urm-controls` queue without SMTP/OAuth credentials. Reviewed closure therefore remains available while email activity slots are occupied.

See [Nodemailer's verification limits](https://nodemailer.com/smtp) and [SendGrid's authenticated scope endpoint](https://www.twilio.com/docs/sendgrid/api-reference/api-key-permissions/retrieve-a-list-of-scopes-for-which-this-user-has-access).
