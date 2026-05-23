const assert = require('node:assert/strict');

const {
  analyzeYouTubeFailure,
  classifyYouTubeFailure,
  shouldEscalateToBrowserFallback,
  shouldEscalateToCookieProvider,
  annotateYouTubeFailure,
} = require('../dist/youtubeExtractionPolicy');

function main() {
  assert.equal(
    classifyYouTubeFailure("ERROR: [youtube] Sign in to confirm you're not a bot", 'public_provider'),
    'public_path_bot_blocked'
  );
  assert.equal(
    classifyYouTubeFailure('ERROR: [youtube] The page needs to be reloaded.', 'cookie_provider'),
    'cookie_session_stale_or_challenged'
  );
  assert.equal(
    classifyYouTubeFailure(
      'Configured cookie-backed YouTube session is disabled by the cookie circuit breaker.',
      'public_provider'
    ),
    'cookie_session_stale_or_challenged'
  );
  assert.equal(
    classifyYouTubeFailure('ERROR: LOGIN_REQUIRED private members-only age-restricted', 'public_provider'),
    'account_required_content'
  );
  assert.equal(
    classifyYouTubeFailure('ERROR: [youtube] Foujg31dBG8: This live event has ended.', 'public_provider'),
    'post_live_archive_not_ready'
  );

  assert.equal(shouldEscalateToCookieProvider('account_required_content', true, false), true);
  assert.equal(shouldEscalateToCookieProvider('public_path_bot_blocked', true, false), true);
  assert.equal(shouldEscalateToCookieProvider('unknown_youtube_extractor_failure', true, false), false);
  assert.equal(shouldEscalateToCookieProvider('post_live_archive_not_ready', true, false), false);
  assert.equal(shouldEscalateToCookieProvider('post_live_archive_not_ready', true, true), false);
  assert.equal(shouldEscalateToCookieProvider('account_required_content', false, false), false);
  assert.equal(shouldEscalateToCookieProvider('unknown_youtube_extractor_failure', true, true), true);

  const analyzedPublicBotBlock = analyzeYouTubeFailure(
    'WARNING: [youtube] Unable to download webpage: HTTP Error 429: Too Many Requests\nERROR: [youtube] abc123: Sign in to confirm you’re not a bot',
    'public_provider'
  );
  assert.equal(analyzedPublicBotBlock.failureClass, 'public_path_bot_blocked');
  assert.equal(analyzedPublicBotBlock.alertCode, 'public_ip_or_reputation_block');
  assert.equal(analyzedPublicBotBlock.stage, 'webpage_request');
  assert.equal(analyzedPublicBotBlock.sawHttp429, true);
  assert.equal(analyzedPublicBotBlock.sawBotPrompt, true);
  assert.equal(shouldEscalateToBrowserFallback(analyzedPublicBotBlock, true), true);

  const analyzedCookieFailure = analyzeYouTubeFailure(
    'ERROR: [youtube] abc123: The page needs to be reloaded.',
    'cookie_provider'
  );
  assert.equal(analyzedCookieFailure.failureClass, 'cookie_session_stale_or_challenged');
  assert.equal(analyzedCookieFailure.stage, 'cookie_session');
  assert.equal(shouldEscalateToBrowserFallback(analyzedCookieFailure, true), false);

  const analyzedPostLiveFailure = analyzeYouTubeFailure(
    'yt-dlp download format selection exited with code 1. stderr: ERROR: [youtube] Foujg31dBG8: This live event has ended.',
    'public_provider'
  );
  assert.equal(analyzedPostLiveFailure.failureClass, 'post_live_archive_not_ready');
  assert.equal(analyzedPostLiveFailure.alertCode, 'post_live_archive_not_ready');
  assert.equal(analyzedPostLiveFailure.stage, 'post_live_archive');
  assert.equal(shouldEscalateToBrowserFallback(analyzedPostLiveFailure, true), false);

  const analyzedUnknownFailure = analyzeYouTubeFailure('ERROR: [youtube] extractor exploded', 'public_provider');
  assert.equal(shouldEscalateToBrowserFallback(analyzedUnknownFailure, true), false);
  assert.equal(shouldEscalateToBrowserFallback(analyzedPublicBotBlock, false), false);

  const annotated = annotateYouTubeFailure(
    'ERROR: [youtube] The page needs to be reloaded.',
    'cookie_session_stale_or_challenged',
    'cookie_provider'
  );
  assert.match(annotated, /Rotate the yt-dlp cookies/i);

  const annotatedPostLive = annotateYouTubeFailure(
    'ERROR: [youtube] Foujg31dBG8: This live event has ended.',
    'post_live_archive_not_ready',
    'public_provider'
  );
  assert.match(annotatedPostLive, /livestream archive/i);
  assert.doesNotMatch(annotatedPostLive, /unknown YouTube extraction error/i);

  console.log('youtube policy verification passed');
}

main();
