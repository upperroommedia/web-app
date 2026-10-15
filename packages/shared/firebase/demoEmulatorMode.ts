/** Explicit production-build emulator mode. This is a closed demo binding, never an auth bypass. */
const demoProject = 'demo-temporal-ci';
const demoDatabaseUrl = 'http://127.0.0.1:19000?ns=demo-temporal-ci';
const expectedPublicConfig = {
  projectId: demoProject,
  apiKey: 'synthetic-public-browser-test-key',
  appId: '1:123456789:web:synthetic',
  authDomain: 'demo-temporal-ci.firebaseapp.com',
  storageBucket: 'demo-temporal-ci.appspot.com',
  imagesBucket: 'demo-temporal-ci-images',
  databaseURL: demoDatabaseUrl,
  functionsRegion: 'us-central1',
  functionsURL: 'http://127.0.0.1:5001/demo-temporal-ci/us-central1',
};
const dedicatedPorts = { auth: '9100', firestore: '18081', database: '19000', storage: '19199', functions: '5001' };

// Static references are essential: Next.js inlines these into the browser build.
const flag = process.env.NEXT_PUBLIC_FIREBASE_DEMO_EMULATORS;
export const isDemoEmulatorMode = flag === 'true';
if (flag !== undefined && !isDemoEmulatorMode) throw new Error('Invalid explicit Firebase demo emulator flag');

if (isDemoEmulatorMode) {
  if (process.env.NODE_ENV !== 'production') throw new Error('Firebase demo mode requires a production build');
  if (
    [
      process.env.AUTH_EMULATOR_STARTED,
      process.env.DATABASE_EMULATOR_STARTED,
      process.env.FIRESTORE_EMULATOR_STARTED,
    ].some((value) => value !== undefined)
  )
    throw new Error('Firebase demo mode does not accept inherited connection markers');
  const priorFirestore = globalThis as { __URM_FIRESTORE__?: unknown; __URM_FIRESTORE_EMULATOR_CONNECTED__?: unknown };
  if (
    priorFirestore.__URM_FIRESTORE__ !== undefined ||
    priorFirestore.__URM_FIRESTORE_EMULATOR_CONNECTED__ !== undefined
  )
    throw new Error('Firebase demo mode does not accept an unverified Firestore cache');
  const configured = {
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    imagesBucket: process.env.NEXT_PUBLIC_FIREBASE_IMAGES_BUCKET,
    databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
    functionsRegion: process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION,
    functionsURL: process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL,
  };
  const ports = {
    auth: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT,
    firestore: process.env.NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT,
    database: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR_PORT,
    storage: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_PORT,
    functions: process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT,
  };
  for (const key of Object.keys(expectedPublicConfig) as Array<keyof typeof configured>) {
    if (configured[key] !== expectedPublicConfig[key]) throw new Error(`Invalid Firebase demo configuration: ${key}`);
  }
  for (const key of Object.keys(dedicatedPorts) as Array<keyof typeof ports>) {
    if (ports[key] !== dedicatedPorts[key]) throw new Error(`Invalid Firebase demo emulator port: ${key}`);
  }
  if (
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID !== undefined &&
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID !== ''
  )
    throw new Error('Firebase demo mode does not allow messaging configuration');
  if (process.env.__FIREBASE_DEFAULTS__ !== undefined)
    throw new Error('Firebase demo mode does not allow environment Firebase defaults');
  if (
    typeof document !== 'undefined' &&
    document.cookie.split(';').some((part) => part.trim().startsWith('__FIREBASE_DEFAULTS__='))
  )
    throw new Error('Firebase demo mode does not allow cookie Firebase defaults');
  if (process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID !== undefined)
    throw new Error('Firebase demo mode does not allow analytics configuration');
  if ((globalThis as { __FIREBASE_DEFAULTS__?: unknown }).__FIREBASE_DEFAULTS__ !== undefined)
    throw new Error('Firebase demo mode does not allow implicit Firebase defaults');
  if (typeof window !== 'undefined') {
    if (!['http://127.0.0.1:3004', 'http://127.0.0.1:3002'].includes(window.location.origin))
      throw new Error('Firebase demo mode requires its loopback browser origin');
  } else {
    // Validate before importing any SDK or reading credentials; no reachability checks.
    const aliases = {
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
      GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
      FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET,
      FIREBASE_IMAGES_BUCKET: process.env.FIREBASE_IMAGES_BUCKET,
      FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL,
      FIREBASE_FUNCTIONS_REGION: process.env.FIREBASE_FUNCTIONS_REGION,
    };
    for (const [key, value] of Object.entries(aliases)) {
      const expected =
        key.endsWith('PROJECT') || key === 'FIREBASE_PROJECT_ID'
          ? demoProject
          : key === 'FIREBASE_STORAGE_BUCKET'
          ? expectedPublicConfig.storageBucket
          : key === 'FIREBASE_IMAGES_BUCKET'
          ? expectedPublicConfig.imagesBucket
          : key === 'FIREBASE_DATABASE_URL'
          ? demoDatabaseUrl
          : expectedPublicConfig.functionsRegion;
      if (value !== undefined && value !== expected) throw new Error(`Conflicting Firebase demo binding: ${key}`);
    }
    if (
      process.env.GOOGLE_APPLICATION_CREDENTIALS !== '/nonexistent/ci-player-no-adc.json' ||
      process.env.METADATA_SERVER_DETECTION !== 'none' ||
      process.env.GCE_METADATA_HOST !== '127.0.0.1:9'
    )
      throw new Error('Firebase demo mode requires its isolated server credential environment');
    const hosts = {
      auth: process.env.FIREBASE_AUTH_EMULATOR_HOST,
      firestore: process.env.FIRESTORE_EMULATOR_HOST,
      database: process.env.FIREBASE_DATABASE_EMULATOR_HOST,
      storage: process.env.FIREBASE_STORAGE_EMULATOR_HOST,
    };
    for (const key of Object.keys(hosts) as Array<keyof typeof hosts>) {
      if (hosts[key] !== `127.0.0.1:${dedicatedPorts[key]}`)
        throw new Error(`Invalid Firebase demo Admin host: ${key}`);
    }
    if (
      process.env.STORAGE_EMULATOR_HOST !== undefined &&
      process.env.STORAGE_EMULATOR_HOST !== 'http://127.0.0.1:19199'
    )
      throw new Error('Invalid Firebase demo Cloud Storage host');
    if (process.env.TEMPORAL_CONNECTION_MODE === 'temporal-cloud')
      throw new Error('Temporal Cloud cannot use Firebase demo emulators');
    if (process.env.FIREBASE_CONFIG !== undefined) {
      let config: unknown;
      try {
        config = JSON.parse(process.env.FIREBASE_CONFIG);
      } catch {
        throw new Error('Firebase demo configuration must be inline JSON');
      }
      if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new Error('Invalid Firebase demo configuration');
      const allowed = {
        projectId: demoProject,
        storageBucket: expectedPublicConfig.storageBucket,
        databaseURL: demoDatabaseUrl,
      };
      for (const [key, value] of Object.entries(config)) {
        if (!(key in allowed) || value !== allowed[key as keyof typeof allowed])
          throw new Error('Conflicting Firebase demo inline configuration');
      }
    }
  }
}

/** Validate a selected existing app as well as newly initialized app options. */
export function assertDemoFirebaseApp(
  options: {
    projectId?: string;
    storageBucket?: string;
    databaseURL?: string;
    apiKey?: string;
    appId?: string;
    authDomain?: string;
    messagingSenderId?: string;
    measurementId?: string;
  },
  admin = false
): void {
  if (!isDemoEmulatorMode) return;
  if (
    !admin &&
    (options.measurementId !== undefined ||
      (options.messagingSenderId !== undefined && options.messagingSenderId !== ''))
  )
    throw new Error('Existing Firebase app conflicts with demo analytics/messaging binding');
  const keys = admin
    ? (['projectId', 'storageBucket', 'databaseURL'] as const)
    : (['projectId', 'storageBucket', 'databaseURL', 'apiKey', 'appId', 'authDomain'] as const);
  for (const key of keys) {
    if (options[key] !== expectedPublicConfig[key])
      throw new Error(`Existing Firebase app conflicts with demo binding: ${key}`);
  }
}

// Module-scoped, shared by both SDK wrappers. Opaque legacy booleans never prove a new instance is connected.
const demoConnections = new WeakMap<object, string>();
export function connectDemoFirebaseEmulator(
  service: keyof typeof dedicatedPorts,
  instance: {
    app: { options: Parameters<typeof assertDemoFirebaseApp>[0] };
    emulatorConfig?: { host: string; port: number | null; protocol: string } | null;
  },
  connect: () => void
): void {
  if (!isDemoEmulatorMode) throw new Error('Explicit Firebase demo connection was not enabled');
  assertDemoFirebaseApp(instance.app.options);
  if (service === 'auth' && instance.emulatorConfig !== null) {
    const config = instance.emulatorConfig;
    if (
      !config ||
      config.host !== '127.0.0.1' ||
      config.port !== Number(dedicatedPorts.auth) ||
      config.protocol !== 'http'
    )
      throw new Error('Existing Firebase Auth emulator connection conflicts with demo binding');
    demoConnections.set(instance, service);
    return;
  }
  const existing = demoConnections.get(instance);
  if (existing !== undefined) {
    if (existing !== service) throw new Error('Firebase demo service instance identity conflicts');
    if (service === 'auth') throw new Error('Existing Firebase Auth emulator connection conflicts with demo binding');
    return;
  }
  connect(); // A failed/late SDK connection is fatal; never mark it or swallow it.
  demoConnections.set(instance, service);
}
