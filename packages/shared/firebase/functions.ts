import { isDemoEmulatorMode, connectDemoFirebaseEmulator } from './demoEmulatorMode';
import firebase, { isEmulatorMode } from './firebase';
import { getFirebaseEmulatorPort } from './emulatorPorts';
/* eslint-disable no-console */

import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

const functions = getFunctions(firebase);
if (isDemoEmulatorMode) {
  connectDemoFirebaseEmulator('functions', functions, () =>
    connectFunctionsEmulator(functions, '127.0.0.1', getFirebaseEmulatorPort('functions'))
  );
} else if (isEmulatorMode) {
  console.log('Connecting to Functions emulator');
  connectFunctionsEmulator(functions, '127.0.0.1', getFirebaseEmulatorPort('functions'));
}
export default functions;
export * from 'firebase/functions';
