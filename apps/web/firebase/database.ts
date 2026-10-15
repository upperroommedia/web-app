import { isDemoEmulatorMode, connectDemoFirebaseEmulator } from '../../../packages/shared/firebase/demoEmulatorMode';
import firebase, { isEmulatorMode } from './firebase';
import { getFirebaseEmulatorPort } from '../../../packages/shared/firebase/emulatorPorts';
/* eslint-disable no-console */

import { connectDatabaseEmulator, getDatabase } from 'firebase/database';
const database = getDatabase(firebase);
if (isDemoEmulatorMode) {
  connectDemoFirebaseEmulator('database', database, () =>
    connectDatabaseEmulator(database, '127.0.0.1', getFirebaseEmulatorPort('database'))
  );
} else if (isEmulatorMode && process.env.DATABASE_EMULATOR_STARTED !== 'true') {
  console.log('Connecting to Database emulator');
  process.env.DATABASE_EMULATOR_STARTED = 'true';
  connectDatabaseEmulator(database, '127.0.0.1', getFirebaseEmulatorPort('database'));
}
export default database;
export * from 'firebase/database';
