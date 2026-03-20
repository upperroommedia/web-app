import type { GetListPublishedDriftInputType, GetListPublishedDriftOutputType } from '../../../../packages/contracts/getListPublishedDrift';
import type {
  ResolveListPublishedDriftInputType,
  ResolveListPublishedDriftOutputType,
} from '../../../../packages/contracts/resolveListPublishedDrift';
import getlistpublisheddrift from '../../getListPublishedDrift';
import resolvelistpublisheddrift from '../../resolveListPublishedDrift';
import { auditPublishedListDrift, resolvePublishedListDrift } from '../../helpers/publishedListDrift';
import { authenticateSubsplash } from '../../subsplashUtils';

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn(),
}));

jest.mock('../../helpers/publishedListDrift', () => ({
  auditPublishedListDrift: jest.fn(),
  resolvePublishedListDrift: jest.fn(),
}));

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

const getListPublishedDriftHandler = getlistpublisheddrift as unknown as (
  request: TestRequestType<GetListPublishedDriftInputType>
) => Promise<GetListPublishedDriftOutputType>;

const resolveListPublishedDriftHandler = resolvelistpublisheddrift as unknown as (
  request: TestRequestType<ResolveListPublishedDriftInputType>
) => Promise<ResolveListPublishedDriftOutputType>;

const authenticateSubsplashMock = authenticateSubsplash as jest.MockedFunction<typeof authenticateSubsplash>;
const auditPublishedListDriftMock = auditPublishedListDrift as jest.MockedFunction<typeof auditPublishedListDrift>;
const resolvePublishedListDriftMock = resolvePublishedListDrift as jest.MockedFunction<typeof resolvePublishedListDrift>;

describe('published list drift callables', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authenticateSubsplashMock.mockResolvedValue('fake-token');
  });

  describe('getlistpublisheddrift', () => {
    it('rejects callers without publish permissions', async () => {
      await expect(
        getListPublishedDriftHandler({
          auth: { uid: 'user-1', token: { role: 'viewer' } },
          data: { listId: 'root-list' },
        })
      ).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('authenticates to Subsplash and returns the drift audit', async () => {
      auditPublishedListDriftMock.mockResolvedValue({
        requestedListId: 'root-list',
        rootListId: 'root-list',
        inSync: true,
        canReorder: true,
        canOverflowPublish: true,
        canDelete: true,
        canRemove: true,
        issues: [
          {
            code: 'IN_SYNC',
            severity: 'info',
            message: 'Published Firebase and Subsplash state are in sync for this list.',
            firestoreListId: 'root-list',
          },
        ],
        localPublishedItems: [],
        remotePublishedItems: [],
        localItems: [],
        remoteNodes: [],
      });

      const result = await getListPublishedDriftHandler({
        auth: { uid: 'publisher-1', token: { role: 'publisher' } },
        data: { listId: 'root-list' },
      });

      expect(authenticateSubsplashMock).toHaveBeenCalledTimes(1);
      expect(auditPublishedListDriftMock).toHaveBeenCalledWith('root-list', 'fake-token');
      expect(result).toEqual({
        requestedListId: 'root-list',
        rootListId: 'root-list',
        inSync: true,
        canReorder: true,
        canOverflowPublish: true,
        canDelete: true,
        canRemove: true,
        issues: [
          {
            code: 'IN_SYNC',
            severity: 'info',
            message: 'Published Firebase and Subsplash state are in sync for this list.',
            firestoreListId: 'root-list',
          },
        ],
        localPublishedItems: [],
        remotePublishedItems: [],
      });
      expect(result).not.toHaveProperty('localItems');
      expect(result).not.toHaveProperty('remoteNodes');
    });
  });

  describe('resolvelistpublisheddrift', () => {
    it('rejects unauthenticated callers', async () => {
      await expect(
        resolveListPublishedDriftHandler({
          auth: undefined,
          data: { listId: 'root-list', strategy: 'IGNORE' },
        })
      ).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('authenticates to Subsplash and delegates the requested strategy', async () => {
      resolvePublishedListDriftMock.mockResolvedValue({
        status: 'ignored',
        rootListId: 'root-list',
        updatedSermonIds: [],
        importedSermonIds: [],
        untouchedUnpublishedSermonIds: ['sermon-unpublished'],
      });

      const result = await resolveListPublishedDriftHandler({
        auth: { uid: 'admin-1', token: { role: 'admin' } },
        data: { listId: 'root-list', strategy: 'IGNORE' },
      });

      expect(authenticateSubsplashMock).toHaveBeenCalledTimes(1);
      expect(resolvePublishedListDriftMock).toHaveBeenCalledWith({
        listId: 'root-list',
        strategy: 'IGNORE',
        token: 'fake-token',
      });
      expect(result).toEqual({
        status: 'ignored',
        rootListId: 'root-list',
        updatedSermonIds: [],
        importedSermonIds: [],
        untouchedUnpublishedSermonIds: ['sermon-unpublished'],
      });
    });
  });
});
