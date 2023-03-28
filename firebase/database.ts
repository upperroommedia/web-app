/* eslint-disable no-console */
/* eslint-disable import/export */
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';
import firebase, { isDevelopment } from './firebase';
const database = getDatabase(firebase);
if (isDevelopment && process.env.FIRESTORE_EMULATOR_STARTED !== 'true') {
  console.log('Connecting to Database emulator');
  process.env.FIRESTORE_EMULATOR_STARTED = 'true';
  connectDatabaseEmulator(database, '127.0.0.1', 9000);
}
export default database;
export * from 'firebase/database';
