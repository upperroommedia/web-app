import type { YouTubeCookieStatus } from './youtubeCookies';

export interface SetYouTubeCookiesInput {
  cookiesBase64: string;
  fileName?: string;
}

export type SetYouTubeCookiesOutputType = YouTubeCookieStatus;
