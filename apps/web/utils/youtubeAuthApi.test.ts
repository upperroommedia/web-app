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
  process.env.YOUTUBE_LOGIN_EMAIL = 'shared-google@example.com';
  process.env.YOUTUBE_LOGIN_PASSWORD = 'test-only-password';
  process.env.TWO_FACTOR_GOOGLE_LOGIN = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
});
afterEach(() => {
  delete process.env.TWO_FACTOR_GOOGLE_LOGIN;
  delete process.env.YOUTUBE_LOGIN_EMAIL;
  delete process.env.YOUTUBE_LOGIN_PASSWORD;
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
    credentialsConfigured: true,
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

it('reveals credentials only after checking the current active admin and never logs them', async () => {
  const audit = jest.spyOn(console, 'info').mockImplementation(() => {});
  expect((await invoke('POST', 'credentials')).status).toBe(401);
  for (const user of [
    { disabled: false, customClaims: { role: 'publisher' } },
    { disabled: false, customClaims: {} },
    { disabled: true, customClaims: { role: 'admin' } },
  ]) {
    getUser.mockResolvedValue(user);
    const denied = await invoke('POST', 'credentials', 'Bearer valid');
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('test-only-password');
  }
  verifyIdToken.mockRejectedValueOnce(new Error('revoked'));
  expect((await invoke('POST', 'credentials', 'Bearer revoked')).status).toBe(401);
  getUser.mockResolvedValue({ disabled: false, customClaims: { role: 'admin' } });
  const result = await invoke('POST', 'credentials', 'Bearer valid');
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ email: 'shared-google@example.com', password: 'test-only-password' });
  expect(result.headers).toContainEqual(['Cache-Control', 'no-store, private']);
  expect(audit).toHaveBeenCalledTimes(1);
  expect(audit).toHaveBeenCalledWith('Admin accessed Google login details', { uid: 'admin' });
  const config = await invoke('GET', '', 'Bearer valid');
  expect(JSON.stringify(config.body)).not.toContain('test-only-password');
  delete process.env.YOUTUBE_LOGIN_PASSWORD;
  expect((await invoke('POST', 'credentials', 'Bearer valid')).status).toBe(503);
});
