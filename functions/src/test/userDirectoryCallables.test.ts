import { toDirectoryUser } from '../userDirectory';

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

jest.mock('firebase-functions/v2', () => {
  const actual = jest.requireActual('firebase-functions/v2');
  return {
    ...actual,
    https: {
      ...actual.https,
      onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
        (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
      ),
    },
    logger: {
      debug: jest.fn(),
      error: jest.fn(),
    },
  };
});

const getUserMock = jest.fn();
const getUsersMock = jest.fn();
const listUsersMock = jest.fn();

jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: {
    auth: () => ({
      getUser: getUserMock,
      getUsers: getUsersMock,
      listUsers: listUsersMock,
    }),
  },
}));

type TestRequest<T> = {
  auth?: {
    uid?: string;
    token?: {
      role?: string;
    };
  };
  data: T;
};

const createUserRecord = (uid: string, role = 'admin') => ({
  uid,
  email: `${uid}@example.test`,
  photoURL: null,
  displayName: `User ${uid}`,
  customClaims: { role },
  emailVerified: true,
  metadata: {
    creationTime: 'Mon, 01 Jan 2024 00:00:00 GMT',
    lastSignInTime: 'Tue, 02 Jan 2024 00:00:00 GMT',
    lastRefreshTime: null,
  },
  providerData: [
    {
      uid,
      displayName: `User ${uid}`,
      email: `${uid}@example.test`,
      photoURL: null,
      providerId: 'password',
      phoneNumber: null,
    },
  ],
  tenantId: null,
  phoneNumber: null,
});

const expectSerializableDirectoryUser = (value: unknown) => {
  expect(() => JSON.stringify(value)).not.toThrow();
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  expect(Object.values(value as Record<string, unknown>).some((field) => typeof field === 'function')).toBe(false);
  expect(value).not.toHaveProperty('toJSON');
  expect(value).not.toHaveProperty('delete');
  expect(value).not.toHaveProperty('getIdToken');
};

describe('user directory callables', () => {
  beforeEach(() => {
    jest.resetModules();
    getUserMock.mockReset();
    getUsersMock.mockReset();
    listUsersMock.mockReset();
  });

  it('maps Firebase Auth users to plain serializable directory users', () => {
    const directoryUser = toDirectoryUser(createUserRecord('user-1') as never);

    expect(directoryUser).toMatchObject({
      uid: 'user-1',
      email: 'user-1@example.test',
      displayName: 'User user-1',
      role: 'admin',
      emailVerified: true,
      providerData: [{ providerId: 'password' }],
    });
    expectSerializableDirectoryUser(directoryUser);
  });

  it('getUser returns a serializable user payload', async () => {
    getUserMock.mockResolvedValue(createUserRecord('user-1'));
    const { default: getUser } = await import('../getUser');
    const handler = getUser as unknown as (request: TestRequest<{ uid: string }>) => Promise<unknown>;

    const response = await handler({
      auth: { uid: 'admin-1', token: { role: 'admin' } },
      data: { uid: 'user-1' },
    });

    expect(response).toMatchObject({ status: 'success', data: { uid: 'user-1' } });
    expectSerializableDirectoryUser((response as { data: unknown }).data);
  });

  it('getUsersByIds returns serializable user payloads', async () => {
    getUsersMock.mockResolvedValue({ users: [createUserRecord('user-1', 'uploader')], notFound: [] });
    const { default: getUsersByIds } = await import('../getUsersByIds');
    const handler = getUsersByIds as unknown as (request: TestRequest<{ uids: string[] }>) => Promise<unknown>;

    const response = await handler({
      auth: { uid: 'admin-1', token: { role: 'admin' } },
      data: { uids: ['user-1'] },
    });

    expect(response).toMatchObject({ status: 'success', data: [{ uid: 'user-1', role: 'uploader' }] });
    expectSerializableDirectoryUser((response as { data: unknown[] }).data[0]);
  });

  it('listUsers returns serializable user payloads', async () => {
    listUsersMock.mockResolvedValue({ users: [createUserRecord('user-1')], pageToken: undefined });
    const { default: listUsers } = await import('../listUsers');
    const handler = listUsers as unknown as (request: TestRequest<Record<string, never>>) => Promise<unknown>;

    const response = await handler({
      auth: { uid: 'admin-1', token: { role: 'admin' } },
      data: {},
    });

    expect(response).toMatchObject({ status: 'success', data: [{ uid: 'user-1' }] });
    expectSerializableDirectoryUser((response as { data: unknown[] }).data[0]);
  });
});
