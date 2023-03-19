/* eslint-disable no-console */
/* eslint-disable import/export */
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import firebase, { isDevelopment } from './firebase';

const auth = getAuth(firebase);
if (isDevelopment && process.env.AUTH_EMULATOR_STARTED !== 'true') {
  console.log('Connecting to Auth emulator');
  process.env.AUTH_EMULATOR_STARTED = 'true';
  connectAuthEmulator(auth, 'http://127.0.0.1:9099');
}

export default auth;
export * from 'firebase/auth';
