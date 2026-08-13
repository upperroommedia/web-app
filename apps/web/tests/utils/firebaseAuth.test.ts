describe('Firebase browser Auth persistence', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.AUTH_EMULATOR_STARTED;
  });

  it('prefers localStorage while allowing existing IndexedDB sessions to migrate', async () => {
    const firebaseApp = { name: 'test-app' };
    const browserLocalPersistence = { type: 'LOCAL' };
    const indexedDBLocalPersistence = { type: 'LOCAL_INDEXED_DB' };
    const explicitlyConfiguredAuth = { app: firebaseApp };
    const getAuth = jest.fn();
    const initializeAuth = jest.fn(() => explicitlyConfiguredAuth);

    jest.doMock('firebase/auth', () => ({
      browserLocalPersistence,
      connectAuthEmulator: jest.fn(),
      getAuth,
      indexedDBLocalPersistence,
      initializeAuth,
    }));
    jest.doMock('../../firebase/firebase', () => ({
      __esModule: true,
      default: firebaseApp,
      isDevelopment: false,
    }));

    const { default: auth } = await import('../../firebase/auth');

    expect(getAuth).not.toHaveBeenCalled();
    expect(initializeAuth).toHaveBeenCalledWith(firebaseApp, {
      persistence: [browserLocalPersistence, indexedDBLocalPersistence],
    });
    expect(auth).toBe(explicitlyConfiguredAuth);
  });

  it('reuses the configured Auth instance when Next.js hot reload re-evaluates the module', async () => {
    const firebaseApp = { name: 'test-app' };
    const browserLocalPersistence = { type: 'LOCAL' };
    const indexedDBLocalPersistence = { type: 'LOCAL_INDEXED_DB' };
    const existingAuth = { app: firebaseApp };
    const getAuth = jest.fn(() => existingAuth);
    const initializeAuth = jest.fn(() => {
      throw Object.assign(new Error('already initialized'), { code: 'auth/already-initialized' });
    });

    jest.doMock('firebase/auth', () => ({
      browserLocalPersistence,
      connectAuthEmulator: jest.fn(),
      getAuth,
      indexedDBLocalPersistence,
      initializeAuth,
    }));
    jest.doMock('../../firebase/firebase', () => ({
      __esModule: true,
      default: firebaseApp,
      isDevelopment: false,
    }));

    const { default: auth } = await import('../../firebase/auth');

    expect(initializeAuth).toHaveBeenCalledWith(firebaseApp, {
      persistence: [browserLocalPersistence, indexedDBLocalPersistence],
    });
    expect(getAuth).toHaveBeenCalledWith(firebaseApp);
    expect(auth).toBe(existingAuth);
  });

  it('does not hide unexpected Firebase initialization failures', async () => {
    const firebaseApp = { name: 'test-app' };
    const initializationError = new Error('unexpected failure');
    const getAuth = jest.fn();

    jest.doMock('firebase/auth', () => ({
      browserLocalPersistence: { type: 'LOCAL' },
      connectAuthEmulator: jest.fn(),
      getAuth,
      indexedDBLocalPersistence: { type: 'LOCAL_INDEXED_DB' },
      initializeAuth: jest.fn(() => {
        throw initializationError;
      }),
    }));
    jest.doMock('../../firebase/firebase', () => ({
      __esModule: true,
      default: firebaseApp,
      isDevelopment: false,
    }));

    await expect(import('../../firebase/auth')).rejects.toBe(initializationError);
    expect(getAuth).not.toHaveBeenCalled();
  });
});
