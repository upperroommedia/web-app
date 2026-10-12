import { getYouTubeAdminToken } from './youtubeAdminToken';
import auth from '../firebase/auth';

const getIdToken = jest.fn().mockResolvedValue('sdk-token');
class SdkUser {
  uid = 'admin';
  getIdToken(forceRefresh: boolean) {
    return getIdToken(forceRefresh);
  }
}
jest.mock('../firebase/auth', () => ({ __esModule: true, default: { currentUser: null } }));
const mockAuth = auth as unknown as { currentUser: SdkUser | null };

beforeEach(() => {
  mockAuth.currentUser = new SdkUser();
  getIdToken.mockClear();
});

it('gets the token from the original SDK user when the context profile loses prototype methods', async () => {
  const profile = { ...mockAuth.currentUser! };
  expect('getIdToken' in profile).toBe(false);
  await expect(getYouTubeAdminToken(profile.uid)).resolves.toBe('sdk-token');
  expect(getIdToken).toHaveBeenCalledWith(false);
  await expect(getYouTubeAdminToken(profile.uid, true)).resolves.toBe('sdk-token');
  expect(getIdToken).toHaveBeenLastCalledWith(true);
});

it('rejects signed-out and mismatched sessions', async () => {
  await expect(getYouTubeAdminToken('another-user')).rejects.toThrow('Sign in again');
  mockAuth.currentUser = null;
  await expect(getYouTubeAdminToken('admin')).rejects.toThrow('Sign in again');
  expect(getIdToken).not.toHaveBeenCalled();
});
