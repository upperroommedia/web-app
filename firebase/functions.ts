/* eslint-disable no-console */
/* eslint-disable import/export */
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import firebase, { isDevelopment } from './firebase';

const functions = getFunctions(firebase);
if (isDevelopment) {
  console.log('Connecting to Functions emulator');
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
export default functions;
export * from 'firebase/functions';
