export type YouTubeExtractionMode = 'public_provider' | 'cookie_provider' | 'browser_fallback';

export type YouTubeFailureClass =
  | 'provider_missing_or_unhealthy'
  | 'public_path_bot_blocked'
  | 'cookie_session_stale_or_challenged'
  | 'account_required_content'
  | 'post_live_archive_not_ready'
  | 'browser_fallback_failed'
  | 'unknown_youtube_extractor_failure';

export type YouTubeAlertCode =
  | 'public_ip_or_reputation_block'
  | 'cookie_session_stale'
  | 'account_required_no_valid_session'
  | 'post_live_archive_not_ready'
  | 'browser_fallback_failed'
  | 'provider_unhealthy'
  | 'youtube_runtime_failure';

export type YouTubeFailureStage =
  | 'webpage_request'
  | 'player_response'
  | 'cookie_session'
  | 'post_live_archive'
  | 'browser_fallback'
  | 'unknown';

export interface YouTubeFailureAnalysis {
  failureClass: YouTubeFailureClass;
  alertCode: YouTubeAlertCode;
  stage: YouTubeFailureStage;
  sawHttp429: boolean;
  sawUnableToDownloadWebpage: boolean;
  sawLoginRequired: boolean;
  sawBotPrompt: boolean;
  sawUnplayable: boolean;
  sawPageReload: boolean;
}

export function classifyYouTubeFailure(message: string, mode: YouTubeExtractionMode): YouTubeFailureClass {
  const lower = message.toLowerCase();

  if (lower.includes('configured youtube cookie session appears stale or challenged')) {
    return 'cookie_session_stale_or_challenged';
  }

  if (lower.includes('this video appears to require an authenticated youtube session')) {
    return 'account_required_content';
  }

  if (
    lower.includes('this live event has ended') ||
    lower.includes('the livestream has not finished processing') ||
    lower.includes('post-live manifestless mode') ||
    lower.includes('live_status=post_live') ||
    lower.includes('live status is post_live') ||
    lower.includes('livestream archive is still being processed')
  ) {
    return 'post_live_archive_not_ready';
  }

  if (
    lower.includes('po token providers: none') ||
    lower.includes('ytdlp_pot_provider_base_url is required') ||
    lower.includes('po token provider') && lower.includes('unhealthy')
  ) {
    return 'provider_missing_or_unhealthy';
  }

  if (lower.includes('cookie circuit breaker')) {
    return 'cookie_session_stale_or_challenged';
  }

  // yt-dlp can complete extraction with cookies and a PO token, then have YouTube
  // reject the subsequent authenticated media request. This is the production
  // signature emitted for an expired or challenged shared browser session.
  if (
    mode === 'cookie_provider' &&
    lower.includes('http error 403') &&
    (lower.includes('unable to download video data') || /fragment \d+ not found/.test(lower))
  ) {
    return 'cookie_session_stale_or_challenged';
  }

  if (lower.includes('the page needs to be reloaded') || lower.includes('unplayable')) {
    return mode === 'cookie_provider' ? 'cookie_session_stale_or_challenged' : 'public_path_bot_blocked';
  }

  if (lower.includes("sign in to confirm you're not a bot") || lower.includes('sign in to confirm you’re not a bot')) {
    return mode === 'cookie_provider' ? 'cookie_session_stale_or_challenged' : 'public_path_bot_blocked';
  }

  if (
    lower.includes('login_required') ||
    lower.includes('this video is private') ||
    lower.includes('members-only') ||
    lower.includes('this video is available to this channel') ||
    lower.includes('age-restricted') ||
    lower.includes('this content isn\'t available') ||
    lower.includes('sign in to confirm your age')
  ) {
    return 'account_required_content';
  }

  if (mode === 'browser_fallback') {
    return 'browser_fallback_failed';
  }

  return 'unknown_youtube_extractor_failure';
}

export function shouldEscalateToCookieProvider(
  failureClass: YouTubeFailureClass,
  hasCookieFallback: boolean,
  useCookiesForPublicVideos: boolean
): boolean {
  if (!hasCookieFallback) return false;
  if (failureClass === 'post_live_archive_not_ready') return false;
  if (useCookiesForPublicVideos) return true;

  return failureClass === 'account_required_content' || failureClass === 'public_path_bot_blocked';
}

export function shouldEscalateToBrowserFallback(
  analysis: YouTubeFailureAnalysis,
  browserFallbackEnabled: boolean
): boolean {
  if (!browserFallbackEnabled) return false;

  return analysis.failureClass === 'public_path_bot_blocked' && (
    analysis.sawHttp429 ||
    analysis.sawBotPrompt ||
    analysis.sawUnableToDownloadWebpage ||
    analysis.sawLoginRequired ||
    analysis.sawUnplayable
  );
}

/**
 * External downloaders make a separate request for the media URL. That is not
 * safe for the cookie-backed provider: YouTube can bind the URL and PO token
 * to the authenticated yt-dlp request context, which an external downloader
 * cannot reproduce reliably.
 */
export function shouldUseExternalDownloaderForYouTubeDownload(mode: YouTubeExtractionMode): boolean {
  return mode === 'public_provider';
}

export function annotateYouTubeFailure(
  message: string,
  failureClass: YouTubeFailureClass,
  mode: YouTubeExtractionMode
): string {
  switch (failureClass) {
    case 'provider_missing_or_unhealthy':
      return `${message} Verify the PO-token provider service and YTDLP_POT_PROVIDER_BASE_URL before retrying.`;
    case 'public_path_bot_blocked':
      return `${message} The public YouTube extraction path was challenged. Verify provider health and the worker's outbound IP reputation.`;
    case 'cookie_session_stale_or_challenged':
      return `${message} The configured YouTube cookie session appears stale or challenged. Rotate the yt-dlp cookies from a fresh private browsing session and retry.`;
    case 'account_required_content':
      return `${message} This video appears to require an authenticated YouTube session. Verify dedicated service-account cookies are configured and healthy.`;
    case 'post_live_archive_not_ready':
      return `${message} YouTube has ended the live event but has not made the livestream archive formats available yet. The worker will retry after YouTube finishes processing the archive.`;
    case 'browser_fallback_failed':
      return `${message} Browser fallback also failed. Inspect the browser fallback worker and its persistent authenticated profile.`;
    case 'unknown_youtube_extractor_failure':
    default:
      return mode === 'browser_fallback'
        ? `${message} Browser fallback failed with an unknown extraction error.`
        : `${message} yt-dlp failed with an unknown YouTube extraction error.`;
  }
}

export function toYouTubeAlertCode(failureClass: YouTubeFailureClass): YouTubeAlertCode {
  switch (failureClass) {
    case 'provider_missing_or_unhealthy':
      return 'provider_unhealthy';
    case 'public_path_bot_blocked':
      return 'public_ip_or_reputation_block';
    case 'cookie_session_stale_or_challenged':
      return 'cookie_session_stale';
    case 'account_required_content':
      return 'account_required_no_valid_session';
    case 'post_live_archive_not_ready':
      return 'post_live_archive_not_ready';
    case 'browser_fallback_failed':
      return 'browser_fallback_failed';
    case 'unknown_youtube_extractor_failure':
    default:
      return 'youtube_runtime_failure';
  }
}

export function analyzeYouTubeFailure(message: string, mode: YouTubeExtractionMode): YouTubeFailureAnalysis {
  const lower = message.toLowerCase();
  const failureClass = classifyYouTubeFailure(message, mode);
  const sawHttp429 = lower.includes('http error 429') || lower.includes('too many requests');
  const sawUnableToDownloadWebpage = lower.includes('unable to download webpage');
  const sawLoginRequired = lower.includes('login_required');
  const sawBotPrompt =
    lower.includes("sign in to confirm you're not a bot") || lower.includes('sign in to confirm you’re not a bot');
  const sawUnplayable = lower.includes('unplayable');
  const sawPageReload = lower.includes('the page needs to be reloaded');
  const sawPostLiveArchive =
    failureClass === 'post_live_archive_not_ready' ||
    lower.includes('this live event has ended') ||
    lower.includes('post-live manifestless mode') ||
    lower.includes('live_status=post_live') ||
    lower.includes('live status is post_live');

  let stage: YouTubeFailureStage = 'unknown';
  if (mode === 'browser_fallback') {
    stage = 'browser_fallback';
  } else if (sawPostLiveArchive) {
    stage = 'post_live_archive';
  } else if (
    mode === 'cookie_provider' &&
    (failureClass === 'cookie_session_stale_or_challenged' || sawPageReload || lower.includes('cookie circuit breaker'))
  ) {
    stage = 'cookie_session';
  } else if (sawHttp429 || sawUnableToDownloadWebpage) {
    stage = 'webpage_request';
  } else if (sawLoginRequired || sawBotPrompt || sawUnplayable) {
    stage = 'player_response';
  }

  return {
    failureClass,
    alertCode: toYouTubeAlertCode(failureClass),
    stage,
    sawHttp429,
    sawUnableToDownloadWebpage,
    sawLoginRequired,
    sawBotPrompt,
    sawUnplayable,
    sawPageReload,
  };
}
