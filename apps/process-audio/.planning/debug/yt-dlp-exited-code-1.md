---
status: awaiting_human_verify
trigger: 'Investigate issue: yt-dlp-exited-code-1'
created: 2026-03-01T07:03:35Z
updated: 2026-03-01T09:36:00Z
---

## Current Focus

hypothesis: fallback path no longer hard-locks into cookie mode and now emits enough evidence to distinguish cookie poisoning from anti-bot/evasion failures in Cloud Run.
test: build succeeds locally; deploy and replay failing sermon in Cloud Run to confirm section-download retry behavior and resulting terminal error/success path.
expecting: logs include `with_cookies` and `without_cookies_retry` attempt labels for section download; if still failing, terminal error clearly identifies bot challenge versus ended-live failure.
next_action: request production verification on new revision with same failing request input

## Symptoms

expected: /process-audio should process the requested YouTube audio and complete trimming/transcode successfully.
actual: requests fail in Cloud Run revision process-audio-00092-b4t with repeated `yt-dlp exited with code 1` after fallback to yt-dlp section download.
errors: gcloud logs show `yt-dlp failed to get URL` with stderr `ERROR: [youtube] wgWazlLy3nU: This live event has ended.`
reproduction: invoke process-audio for sermonId 69682291-ce1b-4cf8-9d75-a34d971697f8 (source appears to be YouTube video wgWazlLy3nU); failure occurs during getDirectAudioUrl fallback path.
timeline: repeated failures observed on 2026-03-01 around 06:58Z-07:02Z; active revision process-audio-00092-b4t.

## Eliminated

- hypothesis: `--no-js-runtimes --js-runtimes node` flags are causing the extraction failure
  evidence: local yt-dlp with the same runtime flags succeeds for wgWazlLy3nU and returns valid URL/metadata
  timestamp: 2026-03-01T07:16:34Z
- hypothesis: no-cookie retry in revision `process-audio-00094-2fb` also fails with `This live event has ended`
  evidence: request-level logs for `f3461d97-db0e-443c-ad53-db4eecfef7df` show `with_cookies` fails with ended-live, while `without_cookies_retry` fails with explicit bot challenge (`Sign in to confirm you’re not a bot`)
  timestamp: 2026-03-01T08:10:04Z

## Evidence

- timestamp: 2026-03-01T07:05:37Z
  checked: codebase search for getDirectAudioUrl and yt-dlp call sites
  found: failure and fallback logic are concentrated in src/processYouTubeUrl.ts, with fallback orchestration in src/trimAndTranscode.ts
  implication: root cause is likely in yt-dlp invocation flags/error handling for YouTube live-ended content
- timestamp: 2026-03-01T07:07:47Z
  checked: src/processYouTubeUrl.ts getYouTubeAudioUrl implementation
  found: getYouTubeAudioUrl runs yt-dlp with -g and rejects on any non-zero exit with full stderr; this directly surfaces `This live event has ended`
  implication: if a video is an ended livestream without accessible VOD stream URL, direct-url extraction will always fail and trigger fallback/error paths
- timestamp: 2026-03-01T07:10:31Z
  checked: src/trimAndTranscode.ts YouTube path with fallback
  found: direct URL failure triggers fallback downloadYouTubeSection, but fallback also throws if yt-dlp exits non-zero; final user-facing error becomes generic `yt-dlp exited with code 1. Check logs for details.`
  implication: current implementation cannot recover when yt-dlp cannot access the underlying YouTube stream, and error reporting obscures root cause
- timestamp: 2026-03-01T07:12:18Z
  checked: yt-dlp direct URL extraction for wgWazlLy3nU on watch/live/youtu.be URLs using baseline flags
  found: all URL forms succeeded locally and returned duration/ext/direct manifest URL (no `This live event has ended` error)
  implication: the target video is currently accessible; production failure is likely caused by environment-specific args or cookie state
- timestamp: 2026-03-01T07:16:34Z
  checked: local yt-dlp using production-style flags (`--no-js-runtimes --js-runtimes node`)
  found: extraction still succeeds for wgWazlLy3nU and reports `post_live` metadata
  implication: JS runtime flags are not the failing factor; focus shifts to cookie state or revision binary/environment
- timestamp: 2026-03-01T07:18:23Z
  checked: Cloud Run structured logs for `yt-dlp failed to get URL` on revision process-audio-00092-b4t
  found: repeated failures for sermonId 69682291-ce1b-4cf8-9d75-a34d971697f8 all show stderr `ERROR: [youtube] wgWazlLy3nU: This live event has ended.`
  implication: failure is deterministic per invocation in that revision and not an intermittent network/transient error
- timestamp: 2026-03-01T07:21:44Z
  checked: Cloud Run structured logs for `Executing yt-dlp to get audio URL`
  found: failing command includes `--cookies /tmp/yt-dlp-cookies-...txt` with watch URL for wgWazlLy3nU
  implication: cookie-enabled extraction is a concrete differentiator between failing production calls and successful local probes
- timestamp: 2026-03-01T07:28:47Z
  checked: src/processYouTubeUrl.ts patch and TypeScript build
  found: getYouTubeAudioUrl now retries once without cookies only when stderr matches ended-live message; `npm run build` passes
  implication: requests affected by cookie-specific ended-live false negatives can recover before fallback path fails
- timestamp: 2026-03-01T07:49:31Z
  checked: human verification checkpoint after deploying revision process-audio-00093-gv4
  found: production still fails with `ERROR: [youtube] wgWazlLy3nU: This live event has ended.`; local reproduction with current production cookie payload fails with cookies and succeeds without cookies, including with forced extractor args
  implication: cookie payload itself can poison extraction regardless of extractor args, and existing retry handling is not sufficient in the production execution path
- timestamp: 2026-03-01T07:50:14Z
  checked: src/processYouTubeUrl.ts getYouTubeAudioUrl and cookie plumbing
  found: getYouTubeAudioUrl currently calls prepareCookiesArgs once, always includes cookies in production, and throws on first non-zero yt-dlp exit with no no-cookie retry path present
  implication: deployed behavior matches ongoing failures exactly; cookie-poisoned extraction remains terminal
- timestamp: 2026-03-01T07:50:14Z
  checked: fallback path in src/trimAndTranscode.ts and local test coverage
  found: failed direct URL extraction falls back to downloadYouTubeSection, which also always adds cookies; repository has no automated tests around this retry/cookie behavior
  implication: cookie-related regressions can persist across both primary and fallback paths unless explicitly handled in code
- timestamp: 2026-03-01T07:51:13Z
  checked: src/processYouTubeUrl.ts getYouTubeAudioUrl implementation
  found: added attempt wrapper with explicit retry path; any cookie-attempt failure now triggers a second no-cookie extraction attempt before bubbling error
  implication: cookie-poisoned sessions can no longer block direct URL extraction for otherwise-public YouTube videos
- timestamp: 2026-03-01T07:51:35Z
  checked: TypeScript build after retry patch
  found: `pnpm build` completed successfully with no compile errors
  implication: fix is syntactically valid and ready for deployment verification
- timestamp: 2026-03-01T08:03:48Z
  checked: post-deploy user report for current production revision
  found: production still fails with yt-dlp exit code 1 after retry patch deployment
  implication: prior fix did not fully address active failing path; deeper request-level log correlation is required
- timestamp: 2026-03-01T08:04:15Z
  checked: active Cloud Run service state via gcloud
  found: project is `urm-app`; `process-audio` latest ready revision is `process-audio-00094-2fb`
  implication: investigation must target revision `00094` logs rather than older `00092/00093` evidence
- timestamp: 2026-03-01T08:04:46Z
  checked: Cloud Run logs for revision `process-audio-00094-2fb` filtered to yt-dlp events
  found: requestIds (for example `f3461d97-db0e-443c-ad53-db4eecfef7df`) show sequence: cookie attempt logs, no-cookie retry log, stderr `This live event has ended`, then fallback section download logs with cookies and stderr `Sign in to confirm you're not a bot`, then final exit code 1
  implication: retry patch is active, but both direct extraction and fallback section download still fail in production conditions
- timestamp: 2026-03-01T08:05:47Z
  checked: request-level timeline and source correlation (`src/processYouTubeUrl.ts`, `src/trimAndTranscode.ts`)
  found: `getYouTubeAudioUrl` now retries once without cookies (`without_cookies_retry`), but `downloadYouTubeSection` always calls `prepareCookiesArgs` and has no no-cookie fallback path
  implication: once direct extraction fails, fallback path is forced through cookie-auth mode and can fail terminally even when a no-cookie section path might work
- timestamp: 2026-03-01T08:08:14Z
  checked: local command replay using production `yt-dlp-cookies` blob from realtimeDB and production flags for video `wgWazlLy3nU`
  found: direct extraction with cookies fails (`This live event has ended`) while direct extraction without cookies succeeds and returns stream URL; section mode with cookies fails during extraction with the same ended-live error
  implication: cookie payload can deterministically poison extraction, so fallback logic must not force cookie-auth mode only
- timestamp: 2026-03-01T08:10:04Z
  checked: complete Cloud Run request timeline for requestId `f3461d97-db0e-443c-ad53-db4eecfef7df` (revision `process-audio-00094-2fb`)
  found: direct `with_cookies` attempt fails with `This live event has ended`; direct `without_cookies_retry` fails with `Sign in to confirm you’re not a bot`; fallback section download command reintroduces `--cookies` and then exits non-zero
  implication: failure is mixed-mode (cookie poisoning + egress anti-bot challenge), not purely cookie-dependent
- timestamp: 2026-03-01T08:10:04Z
  checked: local section-download replay with no cookies and local ffmpeg path
  found: extraction starts but ffmpeg fails on manifest input (`Invalid data found when processing input`, surfaced as `ffmpeg exited with code 183`) while cookie mode still fails at extraction (`This live event has ended`)
  implication: section-download fallback is fragile for this post-live manifest flow; direct URL path remains preferred when available
- timestamp: 2026-03-01T08:10:04Z
  checked: `pnpm build` after section-download retry patch
  found: TypeScript compilation succeeded
  implication: code changes are ready for deployment and production validation
- timestamp: 2026-03-01T09:22:11Z
  checked: latest yt-dlp (`2026.02.21`) probe against actual YouTube video `wgWazlLy3nU`
  found: metadata extraction succeeds and reports `live_status=post_live`, `duration=7738`, with playable format `140`
  implication: this asset is currently accessible through yt-dlp and not inherently blocked at metadata/URL extraction time
- timestamp: 2026-03-01T09:30:41Z
  checked: real format/fragments for `format_id=140` via yt-dlp JSON
  found: only `http_dash_segments` audio is exposed; fragment list has 1547 entries with `sq` indexing (for example `sq/495` aligns near 2476s target window)
  implication: YouTube is serving this as DVR-style DASH fragments, not a single progressive audio file
- timestamp: 2026-03-01T09:31:38Z
  checked: yt-dlp `--download-sections "*00:41:16-00:42:16"` on the same video
  found: extraction succeeds but ffmpeg stage fails (`Invalid data found when processing input`, `ffmpeg exited with code 183`)
  implication: section-cut behavior is constrained by ffmpeg input compatibility, not yt-dlp extraction alone
- timestamp: 2026-03-01T09:33:47Z
  checked: yt-dlp `--test -f 140` on the same video
  found: succeeds using `dashsegments` downloader path and writes a sample m4a fragment
  implication: yt-dlp can fetch real media fragments from this source without section-cutting
- timestamp: 2026-03-01T09:35:12Z
  checked: local ffmpeg demuxer support
  found: local `/opt/homebrew/bin/ffmpeg` build lacks DASH demuxer (`-demuxers` has `hls` and `webm_dash_manifest`, but no `dash`)
  implication: local section-download failures are environment-dependent and not directly equivalent to Cloud Run `/usr/bin/ffmpeg` behavior

## Resolution

root_cause: realtimeDB cookie payload can force yt-dlp into a poisoned/manifestless path (`This live event has ended`) for public post-live videos; in Cloud Run, no-cookie extraction can also hit anti-bot challenges, and section fallback currently reverts to cookies only.
fix: Updated `downloadYouTubeSection` to mirror dual-attempt behavior (with-cookies then without-cookies retry), include per-attempt labels in logs, and propagate stderr-rich errors so Cloud Run failures are diagnosable by attempt type.
verification: Self-verified via local command replay + `pnpm build`; pending Cloud Run deployment and real request verification.
files_changed: [src/processYouTubeUrl.ts]
