/** Public port values are inlined by Next.js; emulator hosts always stay loopback. */
export type FirebaseEmulatorService = 'auth' | 'firestore' | 'database' | 'storage' | 'functions';
const defaults: Record<FirebaseEmulatorService, number> = {
  auth: 9099,
  firestore: 8081,
  database: 9000,
  storage: 9199,
  functions: 5001,
};
export function getFirebaseEmulatorPort(service: FirebaseEmulatorService): number {
  // Keep these references static: dynamic process.env[name] is not browser-inlined.
  const values = {
    auth: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT,
    firestore: process.env.NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT,
    database: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_EMULATOR_PORT,
    storage: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_PORT,
    functions: process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_EMULATOR_PORT,
  };
  const value = values[service];
  if (value === undefined) return defaults[service];
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(
      `Invalid NEXT_PUBLIC_FIREBASE_${service.toUpperCase()}_EMULATOR_PORT: expected a port from 1 to 65535`
    );
  }
  return Number(value);
}
