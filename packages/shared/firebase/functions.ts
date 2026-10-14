import { getFirebaseEmulatorPort } from './emulatorPorts';
/* eslint-disable no-console */

import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import firebase, { isDevelopment } from './firebase';

const functions = getFunctions(firebase);
if (isDevelopment) {
  console.log('Connecting to Functions emulator');
  connectFunctionsEmulator(functions, '127.0.0.1', getFirebaseEmulatorPort('functions'));
}
export default functions;
export * from 'firebase/functions';
