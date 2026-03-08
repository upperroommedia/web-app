# YouTube Trimmer – iOS Behavior

This document describes how the YouTube trimmer ([`components/YouTubeTrimmer.tsx`](../components/YouTubeTrimmer.tsx)) is adapted for iOS (iPhone, iPad) so the video loads and plays correctly in Safari. Future changes should preserve this behavior to avoid regressions.

## Embed URL: `playsinline=1`

The embed URL built by `normalizeYouTubeUrl()` includes `playsinline=1` in the query string. This is **required for inline playback on iOS**. Without it, Safari may force fullscreen or prevent the video from showing inline.

- **Where:** [`normalizeYouTubeUrl`](../components/YouTubeTrimmer.tsx) in `YouTubeTrimmer.tsx`
- **Do not remove** `playsinline=1` from the embed URL when updating embed params.

## Tap-to-load on iOS

iOS Safari often blocks **automatic** loading of embedded media (including YouTube iframes) when it is not initiated by a direct user gesture on or near the media element. Typing in the URL input is a different focus, so calling `startLoading()` from a `useEffect` when the URL changes can be blocked.

To work around this:

1. On **iOS only** (detected via `isIOS()`), we **defer** calling `startLoading()` until the user taps the player area.
2. We show a **“Tap to load video”** overlay over the player container. On tap, we call `startLoading()` and `startLoadingPoster()` (user gesture) and hide the overlay.
3. On **non-iOS** devices, we keep the existing behavior: load automatically when a valid URL is present.

- **Where:** `YouTubeTrimmer` state `hasUserTappedToLoad`, `handleTapToLoad`, and the tap-to-load overlay.
- **Detection:** `isIOS()` uses `navigator.userAgent` and `navigator.platform` (including iPad on iOS 13+).
- **Tests:** Playwright specs run on desktop/mobile viewports; manual checks on real iOS devices or Simulator are recommended for tap-to-load.

## Iframe `allow` and `allowFullScreen`

The Vidstack `MediaProvider` iframe receives:

- `allow`: `accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture`
- `allowFullScreen`: `true`

These match common YouTube embed requirements and help playback and fullscreen work correctly across browsers, including iOS.

## Safari settings we cannot control

The following can still affect embedded YouTube playback **and are outside app control**:

- **“Prevent Cross-Site Tracking”** in Safari settings can block or break YouTube embeds. Users may need to disable it for the site or log into YouTube in Safari.
- **YouTube login** in Safari can improve reliability of embeds on iOS.
- **Ad blockers** or **VPNs** may interfere with playback.

We do not change these; we only document them for troubleshooting.

## References

- [Vidstack YouTube provider](https://vidstack.io/docs/player/api/providers/youtube/)
- [Vidstack #1395 – play loading strategy on iOS Safari](https://github.com/vidstack/player/issues/1395)
- [YouTube embed `playsinline`](https://developers.google.com/youtube/player_parameters#playsinline)
