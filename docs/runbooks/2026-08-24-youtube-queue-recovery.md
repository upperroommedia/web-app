# YouTube queue recovery: 2026-08-24 incident

This is the incident-only acceptance runbook for the [YouTube audio acquisition decision](../adr/2026-08-24-youtube-audio-acquisition.md). It authorizes a pre-PR production acceptance exception for this incident; it does not replace the repository's normal release flow.

## Fixed acceptance cohort

Capture and retain this cohort before deployment. Do not substitute newer requests or regenerate their Request Versions.

| Sermon ID                              | Request Version    | Sermon                                   |
| -------------------------------------- | ------------------ | ---------------------------------------- |
| `4f3de6f7-06c5-4cfe-9ed1-2eed28af6b60` | `2219d0164268964b` | Mother Of All The Living                 |
| `97a1cf59-c1df-4ee6-ba9c-eb8efae4975a` | `71c5e9e61a43e875` | The Four Pillars of the Family of Christ |
| `83984706-b6fa-4dfd-ad9e-4d290dc27344` | `9f7d51c9646ed530` | Belonging to Christ Through Repentance   |
| `27389ff1-ffad-4e88-9304-d74bc0c30c56` | `8edd8f4cb69dc2f3` | A Mother Like No Other                   |
| `a3c1373f-ffcb-4ecd-91d7-d913dbe5fce4` | `81d26d58bd1c4cb5` | A Mother Like No Other – Part 2          |
| `0c9d9dc1-b009-440a-8d5c-f23593081607` | `1ccc2383fdd23d5b` | Christ Transfigured In Glory             |

Baseline observed around 2026-08-24 05:14 UTC: all six Firestore sermon records were `PENDING`; each YouTube URL was publicly visible through oEmbed; the Hetzner Public Provider received a bot/sign-in restriction; and the Cookie Provider downloaded at least 10 KiB of media bytes. Preserve the Firestore records, queue state, Deferred YouTube Requests, provider output, and Request Versions as incident evidence.

## Build and immutable promotion

1. Run the focused local build and tests against the deployable checkout. Commit all deploy-relevant local changes and record the commit SHA.
2. Build one immutable `process-audio` application image from that checkout. Record its registry reference and digest.
3. Deploy that exact digest to staging. Record the running staging container image ID and digest.
4. Complete the staging checks below.
5. Promote the exact same image digest to production without rebuilding it. Stop if the production digest differs from the validated staging digest.
6. Record the production release, commit SHA, image digest, deployment time, and operator.

`scripts/deploy-process-audio-hetzner.sh all` implements this gate as one locked promotion transaction. It hashes the prepared Docker context, builds the candidate only in staging, records and validates its immutable Docker image ID after staging canaries, then retags that exact image for production and starts it with `--no-build`. A standalone `production` deployment refuses an absent, unvalidated, or digest-mismatched candidate. Do not replace this path with independent staging and production rebuilds, and do not infer application image identity from the separately pinned provider image.

## Pre-deployment evidence

- Verify the expected yt-dlp version and PO-token provider are configured, discovered, and reachable.
- Run production-equivalent acquisition probes for the Public Provider and Cookie Provider. The Cookie Provider must download nonzero media bytes. The Public Provider must either download nonzero media bytes or produce the classified authentication-resolvable result that advances to the Cookie Provider; metadata, cookie count, page load, or format selection alone is insufficient.
- Snapshot the six Firestore sermon records, their Request Versions, Deferred YouTube Requests, and YouTube Queue State before changing production.
- Confirm logs and generated evidence redact browser cookies, tokens, and signed media URLs.

## Staging acceptance

- Confirm process liveness and YouTube capability readiness are separately observable.
- Confirm the expected provider version is discovered and the byte canary downloads nonzero media bytes.
- Exercise and retain traces for the Public Provider attempt and an authenticated Cookie Provider fallback. A correctly classified bot/sign-in restriction is an expected Public Provider result on the current Hetzner egress, not a requirement for guest media success.
- If the existing escalation rules select Browser Fallback, retain its Probe Mode, Process Audio Request identity, and YouTube Queue State failure or success evidence.
- Confirm an account-required Public Provider response advances to the Cookie Provider instead of globally blocking the YouTube Task Queue.
- Confirm an unavailable authenticated session produces `WAITING_FOR_YOUTUBE_AUTH` only in the `authenticated_session` scope.
- Confirm File Task Queue work, new Public Provider attempts, and post-live retries continue while that scope waits.

## Production recovery and acceptance

1. Promote the exact staging image digest, then verify the production container reports the expected release and digest.
2. Let the worker signal authenticated-session recovery and automatically claim its probe. Do not restart the process, rewrite queue state, or resubmit sermons to trigger recovery.
3. Verify the probe succeeds, the remaining authentication-scoped Deferred YouTube Requests drain with bounded concurrency, and no replacement deferred record is created.
4. For every sermon in the fixed cohort, verify:
   - its original Request Version is unchanged;
   - it leaves `PENDING` and reaches `PROCESSED`;
   - the expected final audio artifact exists and is nonempty; and
   - queue and worker evidence identify the successful authority without exposing credentials.
5. Confirm File Task Queue and Public Provider work remained healthy during the drain.
6. Check application logs and Sentry for new errors, duplicated processing, lost requests, or secret exposure.

## Release gate and rollback

Do not push this branch and do not create a pull request until the production checklist has passed for all six sermons. Once it passes, retain the evidence and resume the normal GitHub flow.

If a staging canary fails, the image digest changes, or any cohort sermon does not produce its final artifact, the gate has not passed. Keep the branch unpushed, stop the recovery drain if continuing could compound harm, roll production back to the previous image, and preserve the failure evidence for the next attempt.
