// Never silently connect this integration suite to a real Firebase project.
for (const variable of [
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
]) {
  if (!process.env[variable] || !/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[variable])) {
    throw new Error(`Run the local stack suite with firebase.test.json emulators:exec; missing ${variable}`);
  }
}
process.env.FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || 'urm-app';
delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
delete process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL;
process.env.TASK_ORCHESTRATOR_MEDIA = 'temporal';
delete process.env.SUBSPLASH_DEV_MAX_LIST_SIZE;
require('../workflows/media/resource-test-environment.cjs');
