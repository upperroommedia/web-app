# Process Audio

The Process Audio context owns long-running audio work: trimming, transcoding, intro/outro merging, YouTube extraction, and queue coordination.

## Language

**Process Audio Request**:
A request to produce sermon audio from a storage file or YouTube URL with a start time, duration, and optional intro/outro audio.
_Avoid_: Job, task request

**Storage Source**:
A process-audio source backed by a file in storage.
_Avoid_: File source, GCP source

**YouTube Source**:
A process-audio source backed by a YouTube URL.
_Avoid_: Video source, remote source

**Request Version**:
A stable identity for the normalized process-audio request payload.
_Avoid_: Hash, revision

**Process Audio Task**:
The queued execution of a process-audio request in the file or YouTube task queue.
_Avoid_: Cloud task, worker job

**File Task Queue**:
The task queue used for storage-backed process-audio work.
_Avoid_: Storage queue

**YouTube Task Queue**:
The task queue used for YouTube-backed process-audio work.
_Avoid_: Video queue

**Deferred YouTube Request**:
A YouTube request held while the YouTube queue is blocked or waiting for a probe.
_Avoid_: Paused job, delayed job

**YouTube Queue State**:
The shared state describing whether YouTube processing is blocked, probing, or healthy.
_Avoid_: Queue metadata, worker state

**Probe Mode**:
The recovery route being tested for YouTube processing, currently cookie provider or browser fallback.
_Avoid_: Healthcheck mode

**Public Provider**:
The first YouTube extraction path using yt-dlp without cookies.
_Avoid_: Public path

**Cookie Provider**:
The YouTube extraction path using the shared host browser session.
_Avoid_: Cookie path

**Browser Fallback**:
The final YouTube extraction authority used when direct extraction is challenged.
_Avoid_: Browser worker, fallback service

**Runtime Profile**:
The deployment profile that determines whether the worker runs as Cloud Run storage processing or Hetzner YouTube processing.
_Avoid_: Environment, target

**Operational Failure Class**:
The classified reason a YouTube or process-audio operation failed and may need alerting.
_Avoid_: Error type, failure reason
