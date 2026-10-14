# Audio player migration

The web application uses `@videojs/react` 10.1.0's audio preset. The official
Vidstack migration is a component/API rewrite; it is not compatible with the old
`MediaPlayer`/remote-control APIs. The version-matched CLI plan was obtained with
`@videojs/cli@10.1.0 agents init` before source changes. It prints instructions;
it does not rewrite source. Consult the package's bundled `docs/llms.txt` for
future changes and the [official migration guide](https://videojs.org/docs/framework/react/guides/migrate-from-vidstack).

`MediaPlayerComponent` keeps the typed player context above page children so
server-rendered content remains available. The native Audio element and floating
controls remain lazy. Firestore-selected source URLs keep cancellation and
request revision checks; terminal listener errors invalidate pending URL fetches.
Explicit Retry audio refetches failed source resolution or remounts failed media.
Play/seek promise failures are fenced by both media target and source identity.

The custom MUI controls retain the existing responsive floating layout. Sliders
have accessible labels, keyboard operation and value text; the media region has
scoped playback shortcuts without intercepting controls or text inputs. Mute and
volume controls check the actual platform's independent capabilities. Playback
position updates use the Video.js selector store, not the app-wide sermon
context. Scrub gestures cannot commit against a replacement source.

The old Vidstack player automatically populated Media Session metadata from its
title. Video.js 10 has no equivalent extension in the version-matched docs, so a
native adapter preserves the title, hardware play/pause/seek and position state.
Its lifetime and source fences prevent stale handlers from controlling a new
source; a prior adapter cannot clear a newer adapter's ownership. Native position
reporting is limited to whole-second changes. Unsupported APIs do not interrupt
playback. `audioMediaSession.test.ts` covers these lifecycle rules.

The native audio trimmer and YouTube iframe adapter are independent of this
player. Their trimming, bounded waveform and upload/publish behavior must remain
covered by their existing suites. The unused Vidstack-specific trimmer adapter
was removed; neither active provider was replaced.

Required validation for this migration includes CLI-regenerated pnpm lockfile,
clean dependency installation, type checking, unit tests, production build,
SSR/hydration and desktop/mobile browser playback. `audioPlaybackActions.test.ts`
covers rejected commands and source/target races. `audio-player.spec.ts` includes
real native playback with routed local WAV data to exercise Video.js, keyboard
seeking/volume, mute and close without an external media provider. Run browser
suites only against the documented local test environment; seeded records are
restricted to a local Firestore emulator.

A console deprecation warning does not establish a performance regression.
Compare actual route loading, bundle size, responsiveness and player behavior
when reviewing the migration.
