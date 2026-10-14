import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import axios from 'axios';
import { removeFromList } from '../removeFromList';
import { withSubsplashLocks } from '../locks/withSubsplashLocks';
import { getOverflowChainState } from '../helpers/listOverflowChain';

let mockAuthenticated: (() => void) | undefined;
jest.mock('../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn(async () => {
    mockAuthenticated?.();
    return 'test-token';
  }),
  createAxiosConfig: jest.fn(),
}));
// This race must stop before overflow traversal; the real provider lock/service stays intact.
jest.mock('../helpers/listOverflowChain', () => ({
  getOverflowChainState: jest.fn(() => {
    throw new Error('Unexpected overflow traversal before listener admission');
  }),
}));
jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));

const db = firebaseAdmin.firestore(),
  membership = db.doc('sermons/provider-lock-fence/sermonLists/provider-lock-list');
beforeEach(async () => {
  jest.clearAllMocks();
  mockAuthenticated = undefined;
  await membership.delete();
  await firebaseAdmin.database().ref('subsplashLocks').remove();
});
afterAll(async () => {
  await membership.delete();
  await firebaseAdmin.database().ref('subsplashLocks').remove();
});

test('listener rechecks canonical membership after waiting behind a concurrent add on the exact provider locks', async () => {
  let locked!: () => void, releaseAdd!: () => void, authenticated!: () => void;
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const mayFinishAdd = new Promise<void>((resolve) => {
    releaseAdd = resolve;
  });
  const auth = new Promise<void>((resolve) => {
    authenticated = resolve;
  });
  let additionCompleted = false;
  const keys = ['list:provider-lock-list', 'media-item:provider-lock-media'];
  // This uses the same real RTDB lock implementation and lock keys as addToList.
  const addition = withSubsplashLocks(keys, async () => {
    locked();
    await mayFinishAdd;
    await membership.set({
      subsplashId: 'provider-lock-list',
      uploadStatus: { status: 'UPLOADED', listItemId: 'new-row' },
    });
    additionCompleted = true;
  });
  await acquired;
  mockAuthenticated = authenticated;
  const guard = jest.fn(async () => {
    expect(additionCompleted).toBe(true);
    return !(await membership.get()).exists;
  });
  const removal = removeFromList(
    ['provider-lock-list'],
    ['old-row'],
    ['provider-lock-media'],
    ['media-item'],
    undefined,
    undefined,
    guard
  );
  await auth;
  expect(guard).not.toHaveBeenCalled();
  releaseAdd();
  await addition;
  expect(await removal).toEqual([]);
  expect(guard).toHaveBeenCalledTimes(1);
  expect(axios).not.toHaveBeenCalled();
  expect(getOverflowChainState).not.toHaveBeenCalled();
  expect((await membership.get()).get('uploadStatus.listItemId')).toBe('new-row');
});
