/* eslint-disable no-console */
 
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import firebase, { isDevelopment } from './firebase';
import { getFirebaseFunctionsRegion } from '../shared/firebaseProjectConfig';

const functions = getFunctions(firebase, getFirebaseFunctionsRegion());
if (isDevelopment) {
  console.log('Connecting to Functions emulator');
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
export default functions;
export * from 'firebase/functions';
