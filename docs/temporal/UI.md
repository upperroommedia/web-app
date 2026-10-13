# Durable activity in the application

The browser submits intent and displays server-owned job projections. Temporal coordinates processing, publication and cleanup. Closing a page does not cancel admitted work.

## Admission and recovery

`submitDurableIntent` calls `submitDurableJob` with a stable request ID. An accepted receipt identifies a durable job; it does not report that the job finished. If a response is lost, `getDurableJobReceipt` checks the same ID. An unresolved transport failure retains that ID so another attempt checks the same work.

Activity can explicitly check unconfirmed admission IDs from this device after reload, without retaining or replaying original payloads. Recovered jobs have direct links even if they fall outside the recent window.

Pending IDs are stored under versioned keys scoped to Firebase project, hosted/emulator mode and authenticated UID. The key contains a SHA-256 intent fingerprint; the value is an opaque UUID. Job payloads, credentials, invitation tokens and private invitation URLs are not persisted there. Web Locks synchronize ID acquisition across tabs where supported; server admission and generation fencing remain the concurrency boundary. Creation forms also retain their proposed entity ID across an uncertain admission and release it after acceptance.

`submitDurableCommand` requires the observed job revision and a capability supplied by the server. Cancel, retry, resume and verified resolution requests are admissions themselves. A cancellation request remains pending until the workflow finishes cleanup and projects its actual outcome. The client never resets progress or deletes source data after an uncertain result.

## Live projections

The `durableJobs` Firestore collection is read-only to browser clients. The shared subscription registry deduplicates equivalent queries and discards older projection revisions. Cached empty windows cannot erase known outcomes. Network/read failures mark existing status outdated rather than converting successful work into failure.

The Activity page offers bounded cursor pagination for Recent, Active and Needs attention, with 100 visible jobs per page and explicit Newer, Older and Latest controls. Active and attention pages use separate state-filtered server queries so unresolved work is not hidden behind newer completed jobs. Compact summaries remain bounded and do not claim to show every job. The navigation badge counts the active window and displays 100+ at its limit. Per-entity details subscribe to the latest 25 jobs and merge explicit active references outside that history window. A sermon’s server-owned `activeDurableJobs` references permit dedicated, shared observations when an active job falls outside the recent window. Missing job IDs or empty entity IDs create no subscription. Identity changes tear down observations and clear pending local session hints.

The backend must maintain the documented Firestore query indexes and enforce role/ownership authorization. Administrators observe all authorized operational jobs. Publishers and uploaders observe their own requests and jobs targeting their user record. Specific active references remain subject to the same server authorization. Temporal credentials and operational Web UI access are never supplied to application browsers.

## Uploads and audio

Local byte transfer and background processing are separate phases. File uploads first admit an `upload.create` job in `awaiting_source`; the server returns an immutable source session. The browser transfers only to that path and reports the exact Storage generation against the current job revision. It verifies the selected file using a bounded full-content chunk fingerprint, in addition to file metadata.

Upload identity excludes regenerated browser draft IDs and timestamps. A date-only selection is normalized to midnight; image and speaker references are persisted as IDs. Safe draft hints retain only metadata and source fingerprints, never file bytes, token URLs or raw YouTube URLs. Repeating the same source and metadata after an uncertain admission uses the original request identity. Navigation always uses the canonical sermon ID from the server job.

Before transferring or resuming, the browser checks immutable Storage metadata. A matching object reuses its verified generation and submits the same completion command instead of attempting an overwrite. Only an explicit object-not-found response starts another transfer; network and authorization errors preserve the source for review.

Closing a tab stops its local byte transfer. The source session remains discoverable through Activity and can be resumed by reselecting the matching file. The UI warns about leaving during local transfer, but does not hold navigation after admission merely because background processing remains active.

The upload job’s successful outcome means the source is verified and a child audio job was admitted. It is labeled **Source received**, and its processing child remains visible until processing completes. A byte percentage or task-generator response never means **Audio complete**.

Audio playback reads the sermon’s current `audioArtifacts.finalPath`, falling back to `intro-outro-sermons/{sermonId}` for legacy records. Trimming reads `audioArtifacts.sourcePath`, falling back to `sermons/{sermonId}`. Original-source trim coordinates must never be applied to an already trimmed `processedPath`. Source, processed and final artifacts remain distinct and generation-scoped.

Editing metadata with new trim settings submits a single `sermon.update` intent with dependent `processAudio` settings. The server orders processing and provider/domain updates; the browser does not race independent jobs. Published audio can be edited when an original source remains available. Existing SoundCloud tracks require an explicit replacement-or-keep policy: replacement changes the public track link and retains the old track until the replacement is confirmed; keeping existing audio intentionally leaves that destination playing the old recording. The form makes that choice visible before saving.

## Publishing and entity changes

The publish panel chooses destinations and submits canonical entity IDs. The server resolves provider IDs and owns upload, membership, ordering, rollback and recovery. The panel directly observes its accepted job even after that job leaves the latest 25 history entries: active or uncertain work keeps conflicting controls disabled, while a confirmed terminal outcome permits a fresh intent. Acceptance releases the prior request identity; an unresolved admission retains it for deduplication.

The panel no longer writes `publishActivity`, provider IDs or destination status from local effects. List, series and speaker mutations follow the same admission pattern.

Job details show each destination outcome separately. A confirmed Subsplash result remains visible when SoundCloud needs attention. A response lost after remote creation enters reconciliation rather than blindly allocating another item. Recovery controls require a specific server capability. An unknown publishing allocation may expose verified adoption of an existing compatible resource, with an evidence reference, reason and duplicate-risk acknowledgement. Known cleanup resources and orphan acknowledgements use separate retention or authenticated prior-removal review forms; they cannot assert absence from a checkbox. Source-certified critical repair uses an immutable readonly certificate and fixed purpose, without arbitrary provider IDs or desired-operation replay. Mutable-request quarantine offers no generic adoption or retry.

Deleting a sermon queues cleanup and remains observable. The list page does not hide the record or claim deletion completed merely because cleanup was admitted. The server removes domain records at the workflow’s validated completion point.

Image uploads transfer an immutable source, then observe an `image.ingest` job and load its canonical Firestore image result. There is no name-query race or arbitrary 30-second timeout. Cropping and preview remain local interactions.

## Presentation and accessibility

Activity has a persistent navigation entry, responsive summaries and deep links. Task details show actual steps, attempts, retry times, safe failures and allowed recovery actions. Progress is determinate only when a step reports a measurable completed/total pair. No overall percentage is invented from elapsed time or animation.

Live announcements describe state and step changes, not every byte or elapsed second. Status is readable without color or motion. Commands remain disabled when observations are outdated. Details distinguish **Cancellation requested**, **Checking the destination**, **Needs attention** and terminal outcomes.

## Verification

Frontend tests cover shared listener counts, last-consumer teardown, monotonic revisions, cache/read failures, uncertain admission recovery, persistent creation IDs, command revision/capability fencing, canonical publish selections, upload fingerprint and source-generation validation, source retention after uncertainty, image admission, and server-owned edit/delete boundaries.

Browser smoke testing should include reload and a second tab during processing/publishing, navigation after admission, interrupted upload and wrong-file reselection, worker restart/backoff, partial destination outcomes, verified unknown-result recovery, role/session changes, responsive keyboard navigation and cancellation while cleanup is running. Firebase emulator-backed runs must use the dedicated test harness and remain serialized with other emulator suites.

References: [Temporal Visibility](https://docs.temporal.io/visibility), [Temporal cancellation](https://github.com/temporalio/documentation/blob/main/docs/encyclopedia/workflow/cancellation-and-termination.mdx).

## Initial rendering and playback isolation

Public pages render their content while Firebase restores browser authentication. `UserProvider` always supplies context and exposes `loading`; protected `AppLayout` explicitly waits for restoration before allowing private content or redirecting from an effect. No private identity is injected into server HTML.

The SSR-safe Vidstack player context preserves descendant controls and page children in initial HTML. Its visible bottom controls and media provider remain dynamically loaded. An idle app uses on-play loading; choosing a sermon permits immediate provider loading so existing playback interactions remain intact. The server-owned immutable audio path is observed independently and late URL resolutions are fenced to avoid replacing a newer source.

Auth hydration results are fenced against a newer logout/identity change. Foreground refresh checks updated claims at most once per minute, clearing revoked sessions while preserving identity on an offline refresh failure.

Account-claims uncertainty has a distinct operator review form. Confirmation requires an execution evidence reference and reason; the server verifies the original execution has drained and reads exact access claims. The form offers no provider adoption, force-clear or retry action for this state.

Session-revocation uncertainty is reviewed separately from access claims. The server verifies stopped-execution evidence and the frozen session cutoff; the browser cannot retry revocation from this form. A positive late provider acknowledgement identifying another allocation requires explicit administrator retention, with evidence, reason and duplicate acknowledgement, before cancellation cleanup can finish. Retention authorizes no deletion of either the adopted resource or the additional allocation.

An administrator may alternatively verify that the exact additional provider item was already removed. This reviewed cleanup action performs an authenticated absence check; it authorizes no delete and cannot use an arbitrary remote ID.

A server-declared confirmed-resource cleanup review can expose Keep this resource for its fixed receipt and resource ID. This explicit retention records an audited reference and authorizes no delete. Generic uncertain creation never offers blanket retention.

Shared image cleanup never exposes a force-delete checkbox. Server-advertised review decisions can keep the fixed shared resource or verify it was already removed using an authenticated fixed-ID absence check. A completed local cleanup with `remote_retained` explicitly says that the remote image remains.

Development search scans the emulator catalog in bounded pages and shares concurrent scans only inside the authenticated search client. Later searches read fresh data. This avoids a large streamed response stalling the initial results while keeping owner restrictions on every page; hosted search continues using Algolia.

Late allocation acknowledgements can create independent `provider.orphan_review` cases after the original job has completed. They link to the original task and offer only explicit retention or verified prior-removal review; they never cancel or resume the original desired operation. Unknown image allocation cleanup can deliberately retain a verified compatible candidate, while explaining that the original allocation may still be unknown; it cannot force-delete the selected image.

Critical repair is exposed only by an explicit server capability with a valid immutable certificate and fixed repair purpose. An administrator reviews the readonly certificate, evidence reference and reason; certificate changes clear prior approval fields. Tracking repair cannot replay desired operations or create resources. Fixed cleanup may remove only the original recorded resources covered by the certificate. Missing certificates expose no submission action.

Unresolved mutable-provider requests remain an explicit barrier. The UI explains that the original request may still arrive and cancellation cannot finish safely, and exposes no retry, resume, cancellation or arbitrary-provider-ID completion control. Only an explicitly advertised source-certified critical repair can be reviewed. A strictly validated opaque mutation session ID is visible only to administrators; it carries no vendor HTTP data or credentials.

`PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED` uses the same quarantine restrictions, with distinct text explaining that a destination response could not be safely recorded. Raw provider responses are never rendered or reconstructed. Only a server-certified repair capability permits further review.

Activity has bounded global cursor pagination for Recent, Active and Needs attention. Each authorized query reads at most 101 records: 100 visible tasks and one sentinel confirming an older page exists. Stable creation-time and document-ID ordering handles timestamp ties. Requester and own-user-subject pages are merged by revision before selecting the next shared cursor. Only the current page has live subscriptions; older pages retain cursor descriptors, not accumulated task records. Filter or account-scope changes return to the first page. Counts describe the current page rather than claiming a global total, and stale reads do not claim the collection is exhausted.

A stopped, requester-owned source upload can explicitly start a new audio attempt while its original local source remains selected. The client sends a fresh stable admission identity and `retryOfJobId`; the server reuses the original canonical sermon, metadata, list memberships and validated source/range. The UI does not clear the old receipt or inputs before confirmation, and an uncertain new admission retains its identity. Published, deleted, foreign or non-quiescent cases remain blocked with server guidance. Child-confirmed source jobs follow processing review rather than blind reupload. A factual already-complete private receipt navigates to the canonical sermon without another byte transfer.

An unsent provider graph change is distinct from a request of uncertain outcome. `PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT` means the server proved no request was sent and permanently stopped that immutable attempt. The UI allows only advertised cancellation, explains that the destination must be refreshed and a new intent submitted, and suppresses generic resume, retry and provider-ID resolution. An explicitly source-certified critical repair remains a separate capability.

A source-certified legacy SoundCloud review can keep the original track and finish saved local cleanup when its original account cannot be verified, only after an initial read failure before any unsafe request. The critical certificate explicitly advertises `requiresRetentionAcknowledgement`; the admin must supply evidence, reason and `retentionAcknowledged:true`. The readonly certificate pins the original resource; no provider or account ID is editable. The UI explains that the original SoundCloud content may remain online and makes no absence or deletion claim for that track. A fixed-cleanup certificate may also cover other original resources; its separate warning preserves that approved cleanup scope while explicitly keeping the SoundCloud track. Certificate, generation or retention-capability changes clear the prior acknowledgement and review fields. Ordinary unknown results remain separate.
