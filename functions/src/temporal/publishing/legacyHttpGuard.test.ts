const mockVerify = jest.fn();
const mockUser = jest.fn();
const mockRelease = jest.fn();
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    auth: () => ({ verifyIdToken: mockVerify, getUser: mockUser }),
    firestore: () => ({}),
    app: () => ({ options: { projectId: 'test-project' } }),
  },
}));
jest.mock('../legacyAdmissionLease', () => ({
  withLegacyAdmissionLease: (...args: unknown[]) => mockRelease(...args),
}));
import { guardLegacyPublishingHttpMutation } from './legacyHttpGuard';
const response = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
};
beforeEach(() => {
  jest.clearAllMocks();
  mockVerify.mockResolvedValue({ uid: 'admin' });
  mockUser.mockResolvedValue({ uid: 'admin', customClaims: { role: 'admin' } });
  mockRelease.mockImplementation(async (_db, _options, run) => run({ markEffectsStarted: async () => undefined }));
});
it('rejects mutation over GET before touching authentication or release state', async () => {
  const res = response();
  expect(await guardLegacyPublishingHttpMutation({ method: 'GET', headers: {} }, res as never)).toBe(false);
  expect(res.status).toHaveBeenCalledWith(405);
  expect(mockVerify).not.toHaveBeenCalled();
});
it('requires a verified active administrator', async () => {
  const res = response();
  mockUser.mockResolvedValue({ uid: 'user', customClaims: { role: 'publisher' } });
  expect(
    await guardLegacyPublishingHttpMutation(
      { method: 'POST', headers: { authorization: 'Bearer token' } },
      res as never
    )
  ).toBe(false);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(mockRelease).not.toHaveBeenCalled();
});
it.each([
  ['unavailable', 503],
  ['failed-precondition', 409],
])('blocks maintenance when the private owner gate returns %s', async (code, status) => {
  const res = response();
  mockRelease.mockRejectedValue(Object.assign(new Error('Private owner details'), { code }));
  expect(
    await guardLegacyPublishingHttpMutation(
      { method: 'POST', headers: { authorization: 'Bearer token' } },
      res as never
    )
  ).toBe(false);
  expect(res.status).toHaveBeenCalledWith(status);
  expect(JSON.stringify(res.json.mock.calls)).not.toContain('Private owner details');
});
it('allows authenticated POST only when legacy owns open admission', async () => {
  const res = response();
  expect(
    await guardLegacyPublishingHttpMutation(
      { method: 'POST', headers: { authorization: 'Bearer token' } },
      res as never
    )
  ).toBe(true);
  expect(mockRelease).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ domain: 'publishing', actorUid: 'admin', projectId: 'test-project' }),
    expect.any(Function)
  );
});

it('holds admission over the full mutation and preserves failures after effects start', async () => {
  const res = response();
  const mutation = jest.fn().mockRejectedValue(new Error('Mutation failed'));
  await expect(
    guardLegacyPublishingHttpMutation(
      { method: 'POST', headers: { authorization: 'Bearer token' } },
      res as never,
      mutation
    )
  ).rejects.toThrow('Mutation failed');
  expect(mutation).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
});
