jest.mock('../../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({ user: null }),
}));

import {
  resolveSessionSubsplashMediaItemId,
  resolveSessionSubsplashUploadGeneration,
} from '../../components/SermonPublishPanel';

describe('resolveSessionSubsplashMediaItemId', () => {
  it('prefers the explicit media item id from the active publish action', () => {
    expect(resolveSessionSubsplashMediaItemId('session-media', 'persisted-media', 'explicit-media')).toBe('explicit-media');
  });

  it('reuses the same-session media item id before Firestore refresh catches up', () => {
    expect(resolveSessionSubsplashMediaItemId('session-media', undefined, undefined)).toBe('session-media');
  });

  it('falls back to the persisted sermon subsplash id when there is no session override', () => {
    expect(resolveSessionSubsplashMediaItemId(undefined, 'persisted-media', undefined)).toBe('persisted-media');
  });

  it('does not fall back to a stale persisted sermon subsplash id after the session clears a deleted media item', () => {
    expect(resolveSessionSubsplashMediaItemId(null, 'persisted-media', undefined)).toBeUndefined();
  });

  it('ignores empty ids from any source', () => {
    expect(resolveSessionSubsplashMediaItemId('  ', ' persisted-media ', '')).toBe('persisted-media');
  });
});

describe('resolveSessionSubsplashUploadGeneration', () => {
  it('prefers the in-session override after a delete before Firestore refresh catches up', () => {
    expect(resolveSessionSubsplashUploadGeneration(3, 2)).toBe(3);
  });

  it('falls back to the sermon generation when there is no session override', () => {
    expect(resolveSessionSubsplashUploadGeneration(undefined, 4)).toBe(4);
  });

  it('defaults to zero when neither source exists', () => {
    expect(resolveSessionSubsplashUploadGeneration(undefined, undefined)).toBe(0);
  });
});
