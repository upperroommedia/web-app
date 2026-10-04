import type { NextApiRequest, NextApiResponse } from 'next';
import youtubeAuth from '../pages/api/admin/youtube-auth';

const verifyIdToken = jest.fn();
const getUser = jest.fn();
jest.mock('../firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { auth: () => ({ verifyIdToken, getUser }) },
}));
jest.mock('../shared/firebaseProjectConfig', () => ({ getFirebaseProjectId: () => 'urm-app' }));

const invoke = async (method = 'POST', action = 'code', authorization?: string) => {
  const req = { method, body: { action }, headers: { authorization } } as NextApiRequest;
  const response = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  await youtubeAuth(req, response as unknown as NextApiResponse);
  return {
    status: response.status.mock.calls[0][0],
    body: response.json.mock.calls[0][0],
    headers: response.setHeader.mock.calls,
  };
};

beforeEach(() => {
  verifyIdToken.mockReset().mockResolvedValue({ uid: 'admin' });
  getUser.mockReset().mockResolvedValue({ disabled: false, customClaims: { role: 'admin' } });
  process.env.TWO_FACTOR_GOOGLE_LOGIN = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
});
afterEach(() => {
  delete process.env.TWO_FACTOR_GOOGLE_LOGIN;
  jest.restoreAllMocks();
});

it('requires authentication, checks revocation and uses current admin role', async () => {
  expect((await invoke()).status).toBe(401);
  expect(verifyIdToken).not.toHaveBeenCalled();
  getUser.mockResolvedValue({ disabled: false, customClaims: { role: 'publisher' } });
  expect((await invoke('POST', 'code', 'Bearer valid')).status).toBe(403);
  expect(verifyIdToken).toHaveBeenCalledWith('valid', true);
  getUser.mockResolvedValue({ disabled: true, customClaims: { role: 'admin' } });
  expect((await invoke('POST', 'code', 'Bearer valid')).status).toBe(403);
  verifyIdToken.mockRejectedValue(new Error('revoked'));
  expect((await invoke('POST', 'code', 'Bearer revoked')).status).toBe(401);
});

it('returns only a temporary code, prevents caching, and keeps the secret out of configuration', async () => {
  jest.spyOn(console, 'info').mockImplementation(() => {});
  const config = await invoke('GET', '', 'Bearer valid');
  expect(config.body).toEqual({
    sessionUrl: 'https://yt-worker.upperroommedia.org/youtube-auth/session',
    codeConfigured: true,
  });
  const result = await invoke('POST', 'code', 'Bearer valid');
  expect(result.status).toBe(200);
  expect(result.body.code).toMatch(/^\d{6}$/);
  expect(result.body.expiresAtMs).toBeGreaterThan(result.body.serverTimeMs);
  expect(JSON.stringify(result.body)).not.toContain(process.env.TWO_FACTOR_GOOGLE_LOGIN);
  expect(result.headers).toContainEqual(['Cache-Control', 'no-store, private']);
  // eslint-disable-next-line no-console
  expect(console.info).toHaveBeenCalledWith('Admin generated Google login code', { uid: 'admin' });
});

it('fails safely for missing or invalid configuration and unknown actions', async () => {
  delete process.env.TWO_FACTOR_GOOGLE_LOGIN;
  expect((await invoke('POST', 'code', 'Bearer valid')).status).toBe(503);
  process.env.TWO_FACTOR_GOOGLE_LOGIN = 'invalid-secret';
  expect((await invoke('POST', 'code', 'Bearer valid')).status).toBe(503);
  expect((await invoke('POST', 'unknown', 'Bearer valid')).status).toBe(400);
  expect((await invoke('DELETE', 'code', 'Bearer valid')).status).toBe(405);
});
