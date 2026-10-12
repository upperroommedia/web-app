import type { Firestore } from 'firebase/firestore';

jest.mock('../../firebase/firebase', () => {
  const { getApps, initializeApp } = jest.requireActual('firebase/app');
  return {
    __esModule: true,
    default:
      getApps().find((app: { name: string }) => app.name === 'transport-regression') ??
      initializeApp({ projectId: 'transport-regression', apiKey: 'synthetic-key' }, 'transport-regression'),
    isDevelopment: false,
  };
});

type InspectableFirestore = Firestore & {
  _getSettings(): { useFetchStreams: boolean };
};

describe('browser Firestore transport', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  });
  afterAll(async () => {
    const { terminate } = await import('firebase/firestore');
    const { deleteApp } = await import('firebase/app');
    const firestore = globalThis.__URM_FIRESTORE__;
    if (firestore) {
      await terminate(firestore);
      await deleteApp(firestore.app);
    }
    delete globalThis.__URM_FIRESTORE__;
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('uses the SDK XHR transport instead of abortable fetch streams', async () => {
    const { default: firestore } = await import('../../firebase/firestore');
    // Verify the installed SDK consumes the compatibility option, not just that
    // our adapter passes it to a mock. Firebase omits it from its public types.
    expect((firestore as InspectableFirestore)._getSettings().useFetchStreams).toBe(false);
  });

  it('reuses the configured browser singleton across module reloads', async () => {
    const { default: firestore } = await import('../../firebase/firestore');
    jest.resetModules();
    const { default: reloadedFirestore } = await import('../../firebase/firestore');
    expect(reloadedFirestore).toBe(firestore);
  });
});
