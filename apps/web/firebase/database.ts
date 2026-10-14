import { getFirebaseEmulatorPort } from '../../../packages/shared/firebase/emulatorPorts';
/* eslint-disable no-console */

import { connectDatabaseEmulator, getDatabase } from 'firebase/database';
import firebase, { isDevelopment } from './firebase';
const database = getDatabase(firebase);
if (isDevelopment && process.env.DATABASE_EMULATOR_STARTED !== 'true') {
  console.log('Connecting to Database emulator');
  process.env.DATABASE_EMULATOR_STARTED = 'true';
  connectDatabaseEmulator(database, '127.0.0.1', getFirebaseEmulatorPort('database'));
}
export default database;
export * from 'firebase/database';
