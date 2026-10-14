// Test-only child: actual compiled entrypoint, Temporal SDK and Admin sockets.
// Deliberately leave the RTDB listener open; production teardown must close it.
const { resolve } = require('node:path');
for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST']) {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env[key] || '')) throw new Error('Local emulators required');
}
if (!/^127\.0\.0\.1:\d+$/.test(process.env.TEMPORAL_ADDRESS || '')) throw new Error('Local Temporal required');
const entry =
  process.env.WORKER_LIFECYCLE_SOURCE === 'true'
    ? resolve(__dirname, '../../index.ts')
    : resolve(__dirname, '../../../lib/apps/temporal-worker/src/index.js');
const { startWorkerProcess } = require(entry);
const running = startWorkerProcess();
let poll;
let observing = false;
let readySeen = false;
poll = setInterval(async () => {
  if (observing) return;
  observing = true;
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}/readyz`);
    if (!response.ok) {
      observing = false;
      return;
    }
    readySeen = true;
    clearInterval(poll);
    const { getApp } = require('firebase-admin/app');
    const { getDatabase } = require('firebase-admin/database');
    const { getFirestore } = require('firebase-admin/firestore');
    const app = getApp();
    await getFirestore(app).doc('_lifecycle_probe/natural-exit').get();
    getDatabase(app)
      .ref('.info/connected')
      .on('value', (snapshot) => {
        if (snapshot.val() === true) process.stdout.write('LIFECYCLE_SOCKETS_READY\n');
      });
  } catch (error) {
    // Connection refusal before listening is expected; other readiness failures
    // are bounded by the parent watchdog and retained in the child output.
    if (!readySeen) observing = false;
    else {
      console.error('Lifecycle fixture socket setup failed', error);
      process.exitCode = 1;
    }
  }
}, 100);
running
  .finally(() => clearInterval(poll))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
