import axios from 'axios';
import deleteSubsplashList from '../../deleteSubsplashList';
import { authenticateSubsplash } from '../../subsplashUtils';
import { withIdempotency } from '../../locks/withIdempotency';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import { getOverflowChainState } from '../../helpers/listOverflowChain';
import type {
  DeleteSubsplashListInputType,
  DeleteSubsplashListOutputType,
} from '../../../../packages/contracts/deleteSubsplashList';

jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn().mockResolvedValue('fake-token'),
  createAxiosConfig: jest.fn((url: string, token: string, method: string) => ({
    url,
    token,
    method,
    headers: {},
  })),
}));

jest.mock('axios');
jest.mock('../../locks/withIdempotency', () => ({
  withIdempotency: jest.fn(async (_operationKey: string, run: () => Promise<unknown>) => run()),
}));
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: jest.fn(async (_lockKeys: string[], run: () => Promise<unknown>) => run()),
}));
jest.mock('../../helpers/listOverflowChain', () => ({
  getOverflowChainState: jest.fn(),
}));

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

type CallableAuthType = {
  uid?: string;
  token?: {
    role?: string;
  };
};

type TestRequestType<T> = {
  auth?: CallableAuthType;
  data: T;
};

const mockAxios = axios as jest.MockedFunction<typeof axios>;
const mockAuthenticateSubsplash = authenticateSubsplash as jest.MockedFunction<typeof authenticateSubsplash>;
const mockWithIdempotency = withIdempotency as jest.MockedFunction<typeof withIdempotency>;
const mockWithSubsplashLocks = withSubsplashLocks as jest.MockedFunction<typeof withSubsplashLocks>;
const mockGetOverflowChainState = getOverflowChainState as jest.MockedFunction<typeof getOverflowChainState>;
const deleteSubsplashListHandler = deleteSubsplashList as unknown as (
  request: TestRequestType<DeleteSubsplashListInputType>
) => Promise<DeleteSubsplashListOutputType>;

describe('deleteSubsplashList guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUBSPLASH_EMAIL = 'test@example.com';
    process.env.SUBSPLASH_PASSWORD = 'test-password';
    mockAxios.mockResolvedValue({ status: 204, data: null } as never);
    mockAuthenticateSubsplash.mockResolvedValue('fake-token');
    mockWithIdempotency.mockImplementation(async (_operationKey, run) => run());
    mockWithSubsplashLocks.mockImplementation(async (_lockKeys, run) => run());
  });

  it('returns a stable blocked payload for root lists with overflow pages', async () => {
    mockGetOverflowChainState.mockResolvedValueOnce({
      requestedListId: 'root-list',
      rootListId: 'root-list',
      redirectListId: 'root-list',
      logicalCount: 240,
      canMutate: true,
      issues: [],
      nodes: [
        {
          firestoreListId: 'root-list',
          subsplashId: 'subsplash-root',
          name: 'Root List',
          depth: 0,
          count: 199,
          isRoot: true,
          parentFirestoreListId: null,
          nextSubsplashListId: 'subsplash-overflow',
        },
        {
          firestoreListId: 'overflow-list',
          subsplashId: 'subsplash-overflow',
          name: 'More Root List sermons',
          depth: 1,
          count: 41,
          isRoot: false,
          parentFirestoreListId: 'root-list',
          nextSubsplashListId: null,
        },
      ],
    });

    await expect(
      deleteSubsplashListHandler({
        auth: { uid: 'admin-1', token: { role: 'admin' } },
        data: { listId: 'root-list', operationKey: 'delete-root-1' },
      })
    ).resolves.toMatchObject({
      status: 'blocked',
      blocked: {
        reason: 'ROOT_HAS_OVERFLOW_PAGES',
        requestedListId: 'root-list',
        rootListId: 'root-list',
        rootName: 'Root List',
        logicalCount: 240,
        totalPages: 2,
        overflowPageCount: 1,
        overflowPages: [
          {
            firestoreListId: 'overflow-list',
            subsplashId: 'subsplash-overflow',
            name: 'More Root List sermons',
            depth: 1,
            count: 41,
          },
        ],
      },
    });

    expect(mockAuthenticateSubsplash).not.toHaveBeenCalled();
    expect(mockWithIdempotency).not.toHaveBeenCalled();
    expect(mockWithSubsplashLocks).not.toHaveBeenCalled();
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('allows single-page roots to delete through the existing idempotent lock path', async () => {
    mockGetOverflowChainState.mockResolvedValueOnce({
      requestedListId: 'single-root-list',
      rootListId: 'single-root-list',
      redirectListId: 'single-root-list',
      logicalCount: 12,
      canMutate: true,
      issues: [],
      nodes: [
        {
          firestoreListId: 'single-root-list',
          subsplashId: 'subsplash-single-root',
          name: 'Single Root List',
          depth: 0,
          count: 12,
          isRoot: true,
          parentFirestoreListId: null,
          nextSubsplashListId: null,
        },
      ],
    });

    await expect(
      deleteSubsplashListHandler({
        auth: { uid: 'admin-1', token: { role: 'admin' } },
        data: { listId: 'single-root-list', operationKey: 'delete-single-root-1' },
      })
    ).resolves.toEqual({ status: 'deleted' });

    expect(mockWithIdempotency).toHaveBeenCalledWith('delete-single-root-1', expect.any(Function));
    expect(mockWithSubsplashLocks).toHaveBeenCalledWith(
      ['list:subsplash-single-root'],
      expect.any(Function),
      expect.objectContaining({ operationKey: 'delete-single-root-1' })
    );
    expect(mockAuthenticateSubsplash).toHaveBeenCalled();
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });
});
