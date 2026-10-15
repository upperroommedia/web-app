import { isDemoEmulatorMode, connectDemoFirebaseEmulator } from './demoEmulatorMode';
import firebase, { isEmulatorMode } from './firebase';
import { getFirebaseEmulatorPort } from './emulatorPorts';
/* eslint-disable no-console */

import { connectAuthEmulator, getAuth } from 'firebase/auth';

const auth = getAuth(firebase);
if (isDemoEmulatorMode) {
  connectDemoFirebaseEmulator('auth', auth, () =>
    connectAuthEmulator(auth, `http://127.0.0.1:${getFirebaseEmulatorPort('auth')}`)
  );
} else if (isEmulatorMode && process.env.AUTH_EMULATOR_STARTED !== 'true') {
  console.log('Connecting to Auth emulator');
  process.env.AUTH_EMULATOR_STARTED = 'true';
  connectAuthEmulator(auth, `http://127.0.0.1:${getFirebaseEmulatorPort('auth')}`);
}

export default auth;
export * from 'firebase/auth';
