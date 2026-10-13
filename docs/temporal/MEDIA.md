# Durable audio processing

The media coordinator serializes requests for one sermon. Firebase admission commits a private request, desired revision, public job, and broker outbox in one Firestore transaction. Firebase does not connect to the private Temporal cluster. Workflow history contains project/job/sermon IDs, revision, request version and queue names; media URLs, cookies, profile contents and audio bytes remain outside history.

## Resource ownership and cutover

`temporalMediaState/<sermonId>` identifies the desired request and orchestration owner. The admission factory requires an `assertLegacyDrained` implementation. Enable Temporal ingress only after legacy Cloud Tasks have stopped accepting work and running/queued/deferred requests are drained or imported. An outage must fail closed or leave an admitted outbox pending; it must not create a second legacy owner.

Private documents:

- `temporalMediaRequests/<jobId>`: immutable input and source object generations; mutable stage receipts.
- `temporalMediaAdmissions/<hash>`: caller request deduplication.
- `temporalMediaState/<sermonId>`: current desired revision and completed reference.
- `temporalMediaRecovery/authenticated`: safe media-byte canary evidence.
- `temporalMediaRequests/<jobId>/observers/<hash>`: IDs of dependency workflows waiting for terminal acknowledgement.
- `temporalPublishingAudioDependencies/<parentJobId>`: the atomically admitted audio dependency for a publishing request.

Only service accounts may read/write these collections. The public job projection follows the common durable job schema.

## Workflow and activities

`SermonAudioCoordinator` accepts `media.request`, `media.cancel` and `media.authRecovered` signals. It coalesces pending edits, waits durably for YouTube authentication and archive readiness, and fences publication against the latest desired revision. It bounds history with continue-as-new. Activity failures use bounded retries; waiting for administrator authentication does not consume transport retry attempts.

An idle coordinator completes after ten minutes with all signal handlers finished. Singleton `signalWithStart` admission must allow a new execution after completion. During active runs, Worker Deployment version changes are adopted only at safe stage checkpoints using SDK 1.24's `initialVersioningBehavior: AUTO_UPGRADE` continue-as-new option. Authentication/archive waits check every five minutes; the original archive deadline is carried into the new run. In-flight native work drains before rotating. This is the SDK's experimental upgrade-on-continue-as-new feature, not the deprecated Build ID versioning API. Retain the old deployment until its remaining bounded native activities and pinned executions drain; never remove it merely because the new deployment became current.

`AwaitSermonAudio` is a bounded child dependency for sermon edits. Processing remains owned by the single coordinator. Completion signals are the primary notification; persisted terminal state and exponentially backed-off durable timers reconcile missing signals. Observer registration followed by an immediate status read closes the completion race. Parent cancellation persists a cancellation request, signals its media job and waits for native cleanup acknowledgement before returning cancellation. Dependency admission checks the publishing parent generation and cancellation state in the same transaction that creates media work.

The activity factory executes the actual pipeline, rather than retrying the old synchronous HTTP endpoint:

1. Validate request and sermon ownership; project the preparation stage.
2. Acquire source audio, retain an immutable source snapshot, trim and transcode into an immutable processed artifact.
3. Download pinned bumper generations and the processed receipt, merge into an immutable final artifact.
4. Verify storage generations, then transactionally publish artifact references and audio status only if the desired revision is still current.

Native media commands emit heartbeats, accept cancellation, receive SIGTERM followed by SIGKILL when needed, and must close before temporary files are removed. Nested YouTube probes and HTTP requests share the acquisition's cancellation lifetime. Workflow cancellation waits for activity cleanup.

Each artifact upload uses a unique attempt object and create-only generation preconditions. A successful Firestore stage receipt allows a retry to reuse completed work. An ambiguous receipt commit never deletes the object it may reference. Worker-history errors exclude raw provider diagnostics.

Pending intermediate revisions are marked superseded during admission. A running revision retains its running ownership until cleanup, so dropping a coalesced edit cannot leave a job queued forever or prematurely acknowledge active work. Re-trimming reuses an existing immutable raw acquisition instead of uploading another full copy.

## Playback and trimming

`sermon.audioArtifacts` publishes `sourcePath`, `sourceDurationSeconds`, `processedPath`, `finalPath`, actual final duration, revision and request version. `sourcePath` is the immutable original acquisition and uses the original trim coordinate system. `processedPath` is already trimmed. Playback and external publication use `finalPath`. Legacy sermons retain conventional `sermons/<id>`, `processed-sermons/<id>` and `intro-outro-sermons/<id>` fallbacks.

Audio updates modify `status.audioStatus`, `status.message` and audio metadata only. They preserve SoundCloud/Subsplash publication state. Existing RTDB `addIntroOutro/<sermonId>` progress remains available for older screens; the public durable job reports stage state and only measured progress.

## YouTube recovery

A real authenticated media-byte canary must succeed before authenticated requests resume. Saving cookies or reporting a browser login is insufficient. The worker coalesces concurrent probes and persists safe evidence. Auth-required requests remain separate from public-provider acquisition; protected content cannot block unrelated sermons. Authentication attempts are bounded at six. Post-live archive retries preserve delays of 30 minutes, one hour, two hours, four hours, then six hours, up to twelve attempts.

Interactive browser login continues through its existing authenticated desktop interface. Signals contain recovery generations only. Native browser-profile leases and storage-generation safeguards remain necessary independently of Temporal orchestration.

## Verification

Native process tests cover cancellation of silent children, waiting for process close, already-cancelled starts, measured ffmpeg progress parsing and provider diagnostic redaction. Real Temporal time-skipping tests cover coalescing, captured-history replay, authentication waits, archive timers, native cancellation acknowledgement, bounded parent completion/cancellation, and idle retirement/restart. Transaction-admission tests cover atomic source confirmation, concurrent cancellation replay, pinned generations, actor identity, request deduplication and pending coalesced-job settlement. The dedicated Firebase emulator configuration remains the only supported emulator datastore harness.

Official references: [TypeScript SDK](https://docs.temporal.io/develop/typescript), [activity timeouts/retries](https://docs.temporal.io/develop/typescript/activities/timeouts), [cancellation](https://docs.temporal.io/develop/typescript/workflows/cancellation), [message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing), [continue-as-new](https://docs.temporal.io/develop/typescript/workflows/continue-as-new).

## Artifact retention

Every immutable attempt object is indexed in `temporalMediaArtifacts` before upload. Active references protect canonical source/processed/final paths, nonterminal media inputs, and provider fetch dependencies. New references and deletion claims serialize through the same artifact document; a claimed generation cannot gain a new lease. Terminal media cleanup releases its job references. Replacing canonical output releases only the replaced canonical references. Publishing references remain until real remote ingestion settles; ambiguous receipts remain protected.

The explicit administrator `maintenance.run` operation `media_artifacts_cleanup` starts `MediaArtifactCleanup`. Dry-run defaults to true. Each activity reads at most 25 indexed candidates and each request permits at most 100 pages. Private checkpoints preserve the original ordering value across object mutations. Actual deletion requires the recorded Storage generation, a current maintenance authorization/generation, no active references, and at least 90 days after the last reference release. Backup policy can extend this period and pause cleanup during restoration. Unknown upload acknowledgements require matching worker ownership metadata before their generation can be adopted; uncertainty produces private review evidence instead of deletion. Legacy unindexed objects are excluded. No production deletion schedule is installed.

## Native capacity

Production defaults reserve 64 GiB per native activity with 16 GiB free disk headroom. Two native slots therefore require at least 144 GiB allocatable scratch; the platform supplies an independent 160 GiB volume per media pod. `TEMPORAL_MEDIA_MAX_SOURCE_BYTES` and `TEMPORAL_MEDIA_MAX_OUTPUT_BYTES` default to 20 GiB each, `TEMPORAL_MEDIA_WORKSPACE_MAX_BYTES` to 64 GiB and `TEMPORAL_MEDIA_DISK_HEADROOM_BYTES` to 16 GiB. Inconsistent settings fail initialization. The process reserves capacity before starting, validates pinned download size, counts streamed bytes, and checks aggregate workspace/native output growth every 500 ms. A breach aborts and drains the native subprocesses before scratch cleanup. ffprobe rejects missing/nonfinite durations, durations above 24 hours, and bitrates above 100 Mbps. Insufficient free disk produces a retryable capacity failure; unsupported media budgets fail permanently with a safe public error.
