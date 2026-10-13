// A newly imported Admin SDK boundary must never silently use production ADC in tests.
// The dedicated harness supplies real loopback emulator addresses. Pure tests get
// a closed local endpoint so an unmocked Firebase call fails instead of mutating data.
for (const name of [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
]) {
  const host = process.env[name];
  if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
    throw new Error(`Refusing non-loopback Firebase test endpoint: ${name}`);
  }
  if (!host) process.env[name] = '127.0.0.1:9';
}
