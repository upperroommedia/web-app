const assert = require('node:assert/strict');

const {
  analyzeYouTubeFailure,
  classifyYouTubeFailure,
  shouldEscalateToBrowserFallback,
  shouldEscalateToCookieProvider,
  shouldUseExternalDownloaderForYouTubeDownload,
  annotateYouTubeFailure,
} = require('../dist/youtubeExtractionPolicy');
const {
  buildBrowserPoTokenExtractorArg,
  isValidBrowserPoToken,
  isYouTubeMedia403,
  mergeBrowserPoTokenExtractorArg,
} = require('../dist/youtubeBrowserPoToken');

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
    classifyYouTubeFailure(
      'ERROR: unable to download video data: HTTP Error 403: Forbidden',
      'cookie_provider'
    ),
    'cookie_session_stale_or_challenged'
  );
  const fragmentedMedia403 =
    'ERROR: [download] Got error: HTTP Error 403: Forbidden. Giving up after 10 retries\n' +
    'ERROR: fragment 844 not found, unable to continue';
  assert.equal(
    classifyYouTubeFailure(fragmentedMedia403, 'cookie_provider'),
    'cookie_session_stale_or_challenged'
  );
  assert.equal(
    classifyYouTubeFailure(fragmentedMedia403, 'public_provider'),
    'unknown_youtube_extractor_failure'
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

  const analyzedCookieMedia403 = analyzeYouTubeFailure(
    'yt-dlp file download exited with code 1. stderr: ERROR: unable to download video data: HTTP Error 403: Forbidden',
    'cookie_provider'
  );
  assert.equal(analyzedCookieMedia403.failureClass, 'cookie_session_stale_or_challenged');
  assert.equal(analyzedCookieMedia403.alertCode, 'cookie_session_stale');
  assert.equal(analyzedCookieMedia403.stage, 'cookie_session');

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

  assert.equal(shouldUseExternalDownloaderForYouTubeDownload('public_provider'), true);
  assert.equal(shouldUseExternalDownloaderForYouTubeDownload('cookie_provider'), false);
  assert.equal(shouldUseExternalDownloaderForYouTubeDownload('browser_fallback'), false);

  const browserPoToken = 'x'.repeat(100);
  assert.equal(isYouTubeMedia403('ERROR: unable to download video data: HTTP Error 403: Forbidden'), true);
  assert.equal(isYouTubeMedia403(fragmentedMedia403), true);
  assert.equal(isYouTubeMedia403('ERROR: fragment 844 not found, unable to continue'), false);
  assert.equal(isYouTubeMedia403('ERROR: [youtube] The page needs to be reloaded.'), false);
  assert.equal(isValidBrowserPoToken(browserPoToken), true);
  assert.equal(isValidBrowserPoToken('too-short'), false);
  assert.equal(buildBrowserPoTokenExtractorArg(browserPoToken), `youtube:po_token=mweb.gvs+${browserPoToken}`);
  assert.equal(
    mergeBrowserPoTokenExtractorArg('youtube:player_client=default,mweb,-web_creator', browserPoToken),
    `youtube:player_client=default,mweb,-web_creator;po_token=mweb.gvs+${browserPoToken}`
  );
  assert.throws(() => mergeBrowserPoTokenExtractorArg('vimeo:client=web', browserPoToken), /YouTube extractor/i);
  assert.throws(() => buildBrowserPoTokenExtractorArg('too-short'), /invalid token/i);

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
