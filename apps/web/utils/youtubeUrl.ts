const YOUTUBE_VIDEO_ID_PATTERN = /^[\w-]{11}$/;
const EMBEDDED_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

const trimTrailingPunctuation = (value: string): string => value.replace(/[),.;]+$/u, '');

const extractYouTubeVideoIdFromUrl = (value: string): string | null => {
  try {
    const url = new URL(trimTrailingPunctuation(value));
    const host = url.hostname.replace(/^www\./u, '');

    let videoId: string | null = null;

    switch (host) {
      case 'youtube.com':
      case 'youtube-nocookie.com':
        if (url.pathname === '/watch') {
          videoId = url.searchParams.get('v');
        } else if (url.pathname.startsWith('/embed/')) {
          videoId = url.pathname.split('/embed/')[1];
        } else if (url.pathname.startsWith('/live/')) {
          videoId = url.pathname.split('/live/')[1];
        } else if (url.pathname.startsWith('/shorts/')) {
          videoId = url.pathname.split('/shorts/')[1];
        }
        break;

      case 'youtu.be':
        videoId = url.pathname.split('/')[1];
        break;

      default:
        return null;
    }

    videoId = videoId?.split('?')[0].split('&')[0].split('#')[0] ?? null;
    return videoId && YOUTUBE_VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
  } catch {
    return null;
  }
};

/**
 * Extract a YouTube video ID from a canonical URL, short URL, embed/live/shorts URL,
 * bare video ID, or pasted text that contains one YouTube URL.
 */
export function extractYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  if (YOUTUBE_VIDEO_ID_PATTERN.test(value)) {
    return value;
  }

  const embeddedUrls = value.match(EMBEDDED_URL_PATTERN) ?? [];
  for (const candidate of [value, ...embeddedUrls]) {
    const videoId = extractYouTubeVideoIdFromUrl(candidate);
    if (videoId) return videoId;
  }

  return null;
}

/**
 * Normalize a YouTube URL or ID into a canonical watch URL.
 */
export function normalizeYouTubeUrl(input: string): string | null {
  const videoId = extractYouTubeVideoId(input);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}
