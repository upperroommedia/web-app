jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { GetYouTubeCookieStatusOutputType } from '@upperroom/contracts/getYouTubeCookieStatus';
import type { SetYouTubeCookiesInput, SetYouTubeCookiesOutputType } from '@upperroom/contracts/setYouTubeCookies';
import getyoutubecookiestatus from '../../../../functions-media/src/getYouTubeCookieStatus';
import setyoutubecookies from '../../../../functions-media/src/setYouTubeCookies';

type AdminAuth = {
  uid?: string;
  token?: {
    role?: string;
    email?: string;
  };
};

type SetCookiesRequest = {
  auth?: AdminAuth;
  data: SetYouTubeCookiesInput;
};

type GetCookiesStatusRequest = {
  auth?: AdminAuth;
  data: Record<string, never>;
};

const setCookiesHandler = setyoutubecookies as unknown as (
  request: SetCookiesRequest
) => Promise<SetYouTubeCookiesOutputType>;

const getCookieStatusHandler = getyoutubecookiestatus as unknown as (
  request: GetCookiesStatusRequest
) => Promise<GetYouTubeCookieStatusOutputType>;

const database = firebaseAdmin.database();
const cookieRef = database.ref('yt-dlp-cookies');
const cookieMetaRef = database.ref('yt-dlp-cookies-meta');

const ADMIN_AUTH: AdminAuth = {
  uid: 'admin-1',
  token: {
    role: 'admin',
    email: 'Admin@Example.com',
  },
};

const SAMPLE_COOKIE_TEXT = [
  '# Netscape HTTP Cookie File',
  '.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tcookie-value',
  '.google.com\tTRUE\t/\tTRUE\t2147483647\tHSID\tgoogle-cookie',
].join('\n');

const SAMPLE_COOKIE_BASE64 = Buffer.from(SAMPLE_COOKIE_TEXT, 'utf8').toString('base64');

describe('YouTube cookie admin callables', () => {
  beforeEach(async () => {
    await Promise.all([cookieRef.remove(), cookieMetaRef.remove()]);
  });

  it('writes cookies to RTDB and clears breaker metadata', async () => {
    await cookieMetaRef.set({
      disabledUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      consecutiveFailures: 4,
      lastFailureClass: 'cookie_session_stale_or_challenged',
      lastFailureMessage: 'The page needs to be reloaded',
      lastHealthStatus: 'stale_or_challenged',
    });

    const result = await setCookiesHandler({
      auth: ADMIN_AUTH,
      data: {
        cookiesBase64: SAMPLE_COOKIE_BASE64,
        fileName: 'cookies.txt',
      },
    });

    expect(result).toMatchObject({
      hasCookies: true,
      cookieBreakerOpen: false,
      disabledUntil: null,
      metadata: expect.objectContaining({
        uploadedByUid: 'admin-1',
        uploadedByEmail: 'admin@example.com',
        sourceFileName: 'cookies.txt',
        consecutiveFailures: 0,
        disabledUntil: null,
        lastFailureAt: null,
        lastFailureClass: null,
        lastFailureMessage: null,
        lastHealthStatus: 'uploaded',
      }),
    });

    const storedCookiesSnapshot = await cookieRef.get();
    const storedMetadataSnapshot = await cookieMetaRef.get();
    const storedMetadata = storedMetadataSnapshot.val();

    expect(storedCookiesSnapshot.val()).toBe(SAMPLE_COOKIE_BASE64);
    expect(storedMetadata).toMatchObject({
      uploadedByUid: 'admin-1',
      uploadedByEmail: 'admin@example.com',
      sourceFileName: 'cookies.txt',
      consecutiveFailures: 0,
    });
    expect(storedMetadata?.cookieHash).toHaveLength(16);
    expect(storedMetadata).not.toHaveProperty('disabledUntil');
    expect(storedMetadata).not.toHaveProperty('lastFailureClass');
    expect(storedMetadata).not.toHaveProperty('lastFailureMessage');
  });

  it('rejects non-admin callers', async () => {
    await expect(
      setCookiesHandler({
        auth: {
          uid: 'publisher-1',
          token: {
            role: 'publisher',
            email: 'publisher@example.com',
          },
        },
        data: {
          cookiesBase64: SAMPLE_COOKIE_BASE64,
        },
      })
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('rejects invalid cookie payloads', async () => {
    const invalidBase64 = Buffer.from('this is not a youtube cookie export', 'utf8').toString('base64');

    await expect(
      setCookiesHandler({
        auth: ADMIN_AUTH,
        data: {
          cookiesBase64: invalidBase64,
        },
      })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('returns metadata without exposing the raw cookie payload', async () => {
    await cookieRef.set(SAMPLE_COOKIE_BASE64);
    await cookieMetaRef.set({
      cookieHash: 'abc123def4567890',
      uploadedAt: '2026-03-24T17:39:43.380Z',
      uploadedByEmail: 'admin@example.com',
      disabledUntil: null,
      consecutiveFailures: 0,
      lastHealthStatus: 'uploaded',
    });

    const result = await getCookieStatusHandler({
      auth: ADMIN_AUTH,
      data: {},
    });

    expect(result).toEqual({
      hasCookies: true,
      cookieBreakerOpen: false,
      disabledUntil: null,
      metadata: expect.objectContaining({
        cookieHash: 'abc123def4567890',
        uploadedByEmail: 'admin@example.com',
      }),
    });
    expect(result).not.toHaveProperty('cookiesBase64');
  });
});
