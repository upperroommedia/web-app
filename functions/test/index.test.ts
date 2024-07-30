import 'jest';
import functions from 'firebase-functions-test';
// import * as admin from 'firebase-admin';
// import { stub } from 'sinon';

// We start FirebaseFunctionsTest offline
functions();

describe('test suite', () => {
  test('abcd', () => {
    expect(1).toBe(1);
  });
});
