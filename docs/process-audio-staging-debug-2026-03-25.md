# Process Audio Staging Debug - 2026-03-25

## Goal
- Identify why staging YouTube retries still fail after uploading fresh cookies.
- Confirm whether Deno / yt-dlp runtime setup is correct.
- Implement the smallest fix that improves correctness and operator feedback.

## Current Evidence
- Staging upload succeeded:
  - `uploadedAt`: `2026-03-25T18:14:41.784Z`
  - `uploadedByEmail`: `youssef.a.asaad@gmail.com`
  - `cookieHash`: `1f92910f29106654`
  - `consecutiveFailures`: `0`
  - `lastHealthStatus`: `uploaded`
  - `yt-dlp-cookies` key exists in RTDB
- The first post-upload live retry failed on `process-audio-staging-00032-ckm`.
- The service immediately reopened the cookie breaker:
  - `disabledUntil`: `2026-03-25T18:46:22.312Z`
  - `lastFailureClass`: `cookie_session_stale_or_challenged`
  - `lastFailureMessage`: `yt-dlp cookie healthcheck exited with code 1. stderr: ERROR: [youtube] aHIlirFdeLU: The page needs to be reloaded.`
- The new alert classification fix is active:
  - alert code is now `cookie_session_stale`
  - error message now explicitly says to rotate cookies from a fresh private browsing session
- The uploaded cookie jar failed almost immediately after upload:
  - upload time: `2026-03-25T18:14:41.784Z`
  - first healthcheck failure time: `2026-03-25T18:16:22.312Z`
  - breaker reopened on the first live request after upload

## Deno Status
- The container explicitly installs Deno in `apps/process-audio/Dockerfile`.
- The service still logs `Using configured JavaScript runtime for yt-dlp`.
- The older yt-dlp debug output that mentions `bun (unavailable)` and `node (unavailable)` is not itself a failure if `deno` is present.
- Upstream yt-dlp guidance confirms Deno is the recommended runtime and enabled by default.

## Working Hypothesis
- The fresh upload is structurally valid but not a healthy YouTube session for yt-dlp.
- The current upload flow only validates file shape, not actual YouTube usability.
- Best fix is on the admin upload path:
  - validate cookies immediately after upload through the deployed process-audio service
  - surface exact healthcheck result before the user retries a sermon
  - keep the existing breaker-reset behavior but let validation reopen it immediately if the cookie session is stale

## Upstream Research
- yt-dlp `EJS` wiki:
  - Deno is the recommended JS runtime and enabled by default.
- yt-dlp `Extractors` wiki:
  - YouTube rotates account cookies on open tabs.
  - Recommended export flow is a fresh private/incognito window, navigate to `youtube.com/robots.txt`, export the Netscape cookies file, and close that window immediately.
- yt-dlp issue `#12912`:
  - Manually exported cookie files can fail for YouTube even when `--cookies-from-browser` works.

## Implemented Fix
- Added a private `process-audio` endpoint to validate currently configured YouTube cookies immediately.
- Updated `setyoutubecookies` to call that endpoint after writing RTDB state.
- Updated the admin UI to:
  - tell the user validation is happening during upload
  - refresh cookie status even if validation fails
  - show a stronger warning about yt-dlp’s recommended export flow

## Progress
- [x] Confirm upload reached staging RTDB.
- [x] Confirm latest staging failure class and breaker metadata.
- [x] Confirm new staging revision is live.
- [x] Research upstream yt-dlp guidance for `The page needs to be reloaded`.
- [x] Implement upload-time validation / better logging fix.
- [ ] Verify on staging with another retry.
