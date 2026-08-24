# YouTube audio acquisition: Public Provider first, Cookie Provider fallback

- Status: Accepted
- Date: 2026-08-24
- Scope: Process Audio Requests with a YouTube Source
- Implementation: Target contract; production acceptance proves the deployed implementation

## Decision

Upper Room Media will attempt every submitted YouTube Source that may be viewable by the configured production account. Acquisition is best effort and follows a strict order:

1. Attempt the Public Provider without browser cookies. Use the configured public PO-token provider and yt-dlp client strategy.
2. If the Public Provider returns an Operational Failure Class that authentication could resolve, immediately attempt the Cookie Provider with the shared host browser session. An account-required response advances to this step; it does not defer the Process Audio Request by itself.
3. Browser Fallback remains the final extraction authority when the existing escalation rules select it. It uses the same controlled authenticated dependency and is not a reason to send cookies during the Public Provider attempt.
4. If the Cookie Provider cannot be attempted because its session is missing, stale, or challenged, or the authenticated attempt proves that session recovery is required, create a Deferred YouTube Request with disposition `WAITING_FOR_YOUTUBE_AUTH`.
5. When the authenticated dependency becomes healthy again, automatically probe and drain its Deferred YouTube Requests. Recovery must not require a process restart, a manual queue rewrite, or resubmitting each sermon.
6. If all applicable extraction authorities run and the configured account still cannot view or download the video, finish with an actionable terminal error. Do not wait forever.

The application must not collect an uploader's YouTube password or cookies. The Cookie Provider and Browser Fallback use only the production service's controlled browser profile.

The required shared contract stores `WAITING_FOR_YOUTUBE_AUTH` in `StoredDeferredYouTubeRequest.disposition`, with dependency scope `authenticated_session`. It is not a new terminal audio status. Firestore may remain `PENDING` while the Process Audio Request is deferred, but APIs and user-facing progress should pair that lifecycle state with the explicit disposition rather than presenting an unexplained stall. The implemented shared queue contract must become the source of truth for recovery, status presentation, readiness, and alerts.

## Failure scopes and queue behavior

YouTube failures are scoped by the dependency that can recover them:

| Scope                                                         | Examples                                                                                                                    | Disposition                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Public Provider (`guest_provider`)                            | Provider unavailable, transient network, or account-required response                                                       | Account-required advances to the Cookie Provider; other retryable failures use normal bounded Process Audio Task retry |
| Cookie Provider or Browser Fallback (`authenticated_session`) | Session unavailable, expired, or challenged; authenticated attempt proves session recovery is required                      | `WAITING_FOR_YOUTUBE_AUTH`; create a Deferred YouTube Request in the authenticated-session scope                       |
| Post-live archive                                             | A completed livestream whose archive is not ready                                                                           | Scheduled post-live retry, independent of the authenticated-session circuit                                            |
| Terminal content                                              | Deleted video, unavailable to the configured account, unrecoverable restriction after all applicable extraction authorities | Actionable error; do not block either queue scope                                                                      |

An authenticated-session failure may pause further authenticated probes, but it must not block new Public Provider attempts, File Task Queue work, or post-live retries. A single failed FIFO probe must never recreate a global YouTube Task Queue outage.

Each Process Audio Request must record YouTube Acquisition Evidence: attempted `public_provider` and `cookie_provider` authorities, their Operational Failure Classes, and whether session recovery is required. This evidence covers direct provider attempts; Browser Fallback outcomes remain represented by Probe Mode and the YouTube Queue State's Operational Failure Class. Status transitions and operational alerts must use that evidence instead of labeling every media `403` as stale cookies.

## Automatic session recovery

The Cookie Provider session is maintained as an operational dependency:

- refresh it proactively and expose its health, last successful validation, profile generation, and last error;
- validate recovery by downloading media bytes, not only by loading a YouTube page or extracting cookies;
- when a new healthy profile generation is observed, atomically claim the oldest `WAITING_FOR_YOUTUBE_AUTH` Deferred YouTube Request as the probe;
- after that probe succeeds, drain the remaining authentication-scoped requests with bounded concurrency;
- if the probe fails, keep only the authentication scope blocked and emit one deduplicated operational alert;
- preserve idempotency so restarts and duplicate recovery signals cannot process a sermon twice.

Normal operation must not depend on an operator logging in every few weeks. Google can still revoke a session or require interactive verification; that condition cannot be guaranteed away. If it occurs, the system stays explicit in `WAITING_FOR_YOUTUBE_AUTH`, continues Public Provider and File Task Queue work, and tells operators that human session restoration is required.

## Readiness and observability

Process liveness and YouTube capability readiness are separate signals. A healthy HTTP process is not evidence that YouTube media acquisition works.

YouTube readiness requires:

- the expected yt-dlp PO-token provider is configured, discovered, and reachable;
- a recent production-equivalent canary downloaded nonzero media bytes;
- the Cookie Provider session state is reported separately from Public Provider capability;
- queue depth, oldest deferred age, blocker reason, active probe, and last successful drain are visible;
- alerts distinguish Public Provider failure, Cookie Provider session recovery, post-live waiting, and terminal content restrictions.

Deploy verification must fail when provider discovery or the byte canary fails. A metadata-only yt-dlp command, cookie count, page load, or successful format selection is insufficient.

## Incident acceptance gate

This incident intentionally uses production acceptance before the normal GitHub handoff. The exact six-sermon cohort, immutable artifact-promotion requirement, and evidence checklist are recorded in the [2026-08-24 YouTube queue recovery runbook](../runbooks/2026-08-24-youtube-queue-recovery.md).

**Do not push the branch and do not create a pull request until the exact staging image has been promoted to production and all six sermons have left `PENDING` with verified final audio artifacts.** Direct local Hetzner deployment is explicitly authorized only for the 2026-08-24 incident. This temporary exception overrides the normal `staging` push and `staging`-to-`main` PR sequence for this acceptance run; it is not the default release policy for unrelated work or non-Hetzner services.

## Honest limitations

YouTube does not provide an official audiovisual download endpoint. This design therefore depends on yt-dlp, changing YouTube clients, cookies, and PO-token providers rather than a stable platform contract. It reduces the blast radius and operational toil; it cannot guarantee permanent access.

Account-viewable does not mean universally retrievable:

- a private video must be shared with the configured account;
- members-only content requires the account to hold the applicable entitlement;
- age-restricted content requires an eligible, verified account;
- region, copyright, DRM, live/archive state, account challenges, rate limits, removal, or YouTube changes can still prevent acquisition.

YouTube's Terms and API policies restrict downloading, storing, separating audio, scraping, and non-API retrieval without approval. This ADR records the approved engineering behavior, not legal authorization. Product owners should obtain appropriate legal review and, where required, YouTube's written approval. See the [YouTube Terms of Service](https://www.youtube.com/static?template=terms), [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies), and [official compliance guide](https://developers.google.com/youtube/terms/developer-policies-guide).

## Rejected alternatives

- **Cookie Provider on every request:** rejected because it couples Public Provider downloads to session health and makes an expired account a global outage.
- **Public Provider only:** rejected because it does not attempt private, members-only, age-gated, or bot-challenged videos that the configured account may view.
- **Manual restart after login:** rejected because it leaves deferred work stuck and makes recovery depend on undocumented operator memory.
- **One global blocked YouTube Task Queue:** rejected because Public Provider, authenticated, and post-live failures have different recovery dependencies.
- **Treat every `403` as stale cookies:** rejected because provider, PO-token, account entitlement, format URL, region, and terminal content failures require different actions.

## Follow-up migration

Direct authorized source upload remains available and should be preferred when an original file exists. It is not required by this decision and this ADR does not change uploader behavior. If YouTube extraction becomes operationally or legally unacceptable, source-first ingestion remains the clean migration boundary.
