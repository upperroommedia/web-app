import { isDemoEmulatorMode, connectDemoFirebaseEmulator } from '../../../packages/shared/firebase/demoEmulatorMode';
import firebase, { isEmulatorMode } from './firebase';
import { getFirebaseEmulatorPort } from '../../../packages/shared/firebase/emulatorPorts';
/* eslint-disable no-console */

import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { getFirebaseFunctionsRegion } from '../shared/firebaseProjectConfig';

const functions = getFunctions(firebase, getFirebaseFunctionsRegion());
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
