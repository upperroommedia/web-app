const mockGuard = jest.fn();
const mockAxios = jest.fn();
const mockAuthenticate = jest.fn();
const mockDb = {};
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => mockDb, app: () => ({ options: { projectId: 'test-project' } }) },
}));
jest.mock('axios', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockAxios(...args),
  isAxiosError: () => false,
}));
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (_options: unknown, handler: unknown) => handler,
  HttpsError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: (...args: unknown[]) => mockAuthenticate(...args),
  createAxiosConfig: jest.fn(),
}));
jest.mock('../../subsplashSecrets', () => ({ subsplashSecretsWithRuntimeAlerts: [] }));
jest.mock('../../handleError', () => ({ __esModule: true, default: (error: unknown) => error }));
jest.mock('../../helpers/subsplashImageRefs', () => ({ repairMismatchedSubsplashImageRefs: jest.fn() }));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: async (_keys: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('../../locks/withIdempotency', () => ({
  withIdempotency: async (_key: unknown, run: () => Promise<unknown>) => run(),
}));
jest.mock('../legacyAdmissionLease', () => ({ withLegacyAdmissionLease: (...args: unknown[]) => mockGuard(...args) }));
import createList from '../../createNewSubsplashList';
import editList from '../../editSubsplashList';
import type { CallableRequest } from 'firebase-functions/v2/https';
beforeEach(() => jest.clearAllMocks());
it.each([
  ['paused', 'unavailable'],
  ['temporal owner', 'failed-precondition'],
])('blocks public provider mutation for %s before any provider call', async (_label, code) => {
  mockGuard.mockRejectedValue(Object.assign(new Error('Release ownership blocked'), { code }));
  const create = createList as unknown as (
    request: Pick<CallableRequest<{ title: string }>, 'data' | 'auth'>
  ) => Promise<unknown>;
  const edit = editList as unknown as (
    request: Pick<CallableRequest<{ listId: string; title: string }>, 'data' | 'auth'>
  ) => Promise<unknown>;
  const auth = { uid: 'admin', rawToken: '', token: { role: 'admin' } as never };
  await expect(create({ data: { title: 'New' }, auth })).rejects.toMatchObject({ code });
  await expect(edit({ data: { listId: 'remote', title: 'New' }, auth })).rejects.toMatchObject({ code });
  expect(mockGuard).toHaveBeenCalledWith(
    mockDb,
    expect.objectContaining({ domain: 'publishing', actorUid: 'admin', projectId: 'test-project' }),
    expect.any(Function)
  );
  expect(mockAxios).not.toHaveBeenCalled();
  expect(mockAuthenticate).not.toHaveBeenCalled();
});
