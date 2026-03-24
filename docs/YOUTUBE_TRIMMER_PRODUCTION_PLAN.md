# YouTube Trimmer Production Plan

## Goal
Ship a deterministic YouTube trimming experience under aggressive programmatic seek/reset interactions.

## Primary References
- YouTube IFrame API `seekTo(seconds, allowSeekAhead)`:
  - https://developers.google.com/youtube/iframe_api_reference#seekTo
- YouTube player states/events (`onStateChange`, buffering semantics):
  - https://developers.google.com/youtube/iframe_api_reference#Events
- Vidstack issue tracking for YouTube seek freeze/stall:
  - https://github.com/vidstack/player/issues/1714
  - https://github.com/vidstack/player/issues/1726
- Vidstack PR for `allowSeekAhead` command packing:
  - https://github.com/vidstack/player/pull/1722

## Observed Failure Pattern (from local logs)
- `reset -> seek` or large timeline seek can transition to `waiting=true`.
- `currentTime` stops advancing while `data-buffering=true`.
- State can remain stuck indefinitely until player session is reset/remounted.

## Strategy
1. Stabilize current Vidstack path to reduce user-facing failures now.
2. Add recovery mechanisms for non-recovering buffering.
3. Move YouTube path behind a dedicated adapter (YouTube IFrame API) while preserving trimmer UI/store.

## Phase 1: Immediate Hardening (Done in app code)
- Ensure YouTube seek command uses `allowSeekAhead=true` (PR-equivalent local patch).
- Normalize zero-seek edge case (`0 -> 0.01`) before programmatic seek.
- Add buffering stall watchdog:
  - detect no time progress while buffering for >8s (outside short seek grace period)
  - remount player session
  - restore intended seek target and play/pause intent

## Phase 2: Deterministic Adapter Boundary
- Introduce a `TrimmerPlayerAdapter` interface:
  - `load`, `play`, `pause`, `seek`, `setMuted`, `toggleFullscreen`, `destroy`
  - callbacks: `onReady`, `onTime`, `onDuration`, `onBuffering`, `onError`, `onEnded`
- Keep trimmer store and slider/input logic unchanged.
- Swap YouTube backend from Vidstack wrapper to direct YouTube IFrame API implementation.

## Phase 3: Recovery + Telemetry Contract
- Track per-seek lifecycle:
  - `seek-requested`, `seek-applied`, `time-progress`, `buffering-enter/exit`, `recovery-triggered`
- Add session-level counters:
  - stall count, recovery count, hard failures.
- Keep recovery path enabled in production until upstream is verified stable in a released dependency.

## Phase 4: Test Gates
- Add deterministic stress tests:
  - play -> random seeks -> reset -> random seeks (looped sequence)
  - seek while paused, seek while playing, seek after reset
  - verify no endless buffering and no max update depth regressions
- Ship gate:
  - zero endless-buffer incidents in CI stress suite
  - recovery path not triggered above threshold in manual soak run

## Exit Criteria
- No persistent buffering in stress scenarios.
- Trim bounds and playhead remain consistent after reset/seek.
- No control-click misfires during slider drag.
- Recovery path rarely/never needed in normal flows.
