import { withOwnedAcquisitionFirebase } from '../../../process-audio/src/temporal/hetzner-acquisition-firebase';
import { getSharedFirebaseAppOwnership } from '@upperroom/shared/firebase/firebaseAdminOwnership';
import native from '@upperroom/shared/firebase/firebaseAdmin';
jest.mock('@upperroom/shared/firebase/firebaseAdminOwnership', () => ({ getSharedFirebaseAppOwnership: jest.fn() }));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: jest.fn(), firestore: jest.fn(), database: jest.fn(), auth: jest.fn(), storage: jest.fn() },
}));
function fixture() {
  const app = {} as never;
  const terminate = jest.fn(async () => undefined),
    remove = jest.fn(async () => undefined),
    offline = jest.fn();
  const owner = { app, isRegistered: () => true, terminateFirestore: terminate, deleteApp: remove };
  let calls = 0;
  jest.mocked(getSharedFirebaseAppOwnership).mockImplementation(() => (++calls === 1 ? undefined : owner));
  jest.mocked(native.app).mockReturnValue(app);
  jest.mocked(native.firestore).mockReturnValue({} as never);
  jest.mocked(native.database).mockReturnValue({ goOffline: offline } as never);
  return { owner, terminate, remove, offline };
}
afterEach(() => jest.resetAllMocks());
test('initialization validation failure deletes only creator-owned app without opening unused clients', async () => {
  const f = fixture();
  jest.mocked(native.app).mockImplementation(() => {
    throw Error('CONTROLLED_INITIALIZATION_FAILURE');
  });
  await expect(withOwnedAcquisitionFirebase(async () => undefined)).rejects.toThrow(
    'CONTROLLED_INITIALIZATION_FAILURE'
  );
  expect(f.remove).toHaveBeenCalledTimes(1);
  expect(f.terminate).not.toHaveBeenCalled();
  expect(native.firestore).not.toHaveBeenCalled();
  expect(native.database).not.toHaveBeenCalled();
});
test('Firestore termination failure still attempts owned app deletion and preserves original failure', async () => {
  const f = fixture();
  f.terminate.mockRejectedValue(Error('CONTROLLED_TERMINATION_FAILURE'));
  await expect(
    withOwnedAcquisitionFirebase(async (sdk) => {
      sdk.firestore();
      sdk.database();
      throw Error('CONTROLLED_WORK_FAILURE');
    })
  ).rejects.toThrow('CONTROLLED_WORK_FAILURE');
  expect(f.offline).toHaveBeenCalledTimes(1);
  expect(f.terminate).toHaveBeenCalledTimes(1);
  expect(f.remove).toHaveBeenCalledTimes(1);
});
test('a cleanup failure cannot return success from the helper scope', async () => {
  const f = fixture();
  f.remove.mockRejectedValue(Error('CONTROLLED_DELETE_FAILURE'));
  await expect(withOwnedAcquisitionFirebase(async () => 42)).rejects.toThrow(
    'YOUTUBE_HELPER_FIREBASE_CLEANUP_UNCONFIRMED'
  );
});
test('preexisting creator ownership is never adopted or deleted', async () => {
  const f = fixture();
  jest.mocked(getSharedFirebaseAppOwnership).mockReturnValue(f.owner);
  await expect(withOwnedAcquisitionFirebase(async () => 42)).rejects.toThrow();
  expect(native.app).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
});

test('stalled termination is bounded and cannot skip independent owned deletion', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    f.terminate.mockImplementation(() => new Promise(() => {}));
    const result = withOwnedAcquisitionFirebase(async (sdk) => {
      sdk.firestore();
      return 42;
    });
    const rejected = expect(result).rejects.toThrow('YOUTUBE_HELPER_FIREBASE_CLEANUP_UNCONFIRMED');
    await jest.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(f.remove).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
