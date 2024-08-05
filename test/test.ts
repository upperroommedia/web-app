import { describe, test, beforeEach, beforeAll, afterAll } from '@jest/globals';
import {
  assertSucceeds,
  assertFails,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { getFirestoreCoverageMeta } from './utils';
import { readFileSync, createWriteStream } from 'node:fs';
import { get } from 'node:http';
import { resolve } from 'node:path';
import { serverTimestamp, setLogLevel } from 'firebase/firestore';
import { FirebaseFirestore } from '@firebase/firestore-types';

let testEnv: RulesTestEnvironment;
let adminDB: FirebaseFirestore;
let uploaderDB: FirebaseFirestore;
let userDB: FirebaseFirestore;
let unauthorizedDB: FirebaseFirestore;
const firebaseCollections: string[] = [
  'sermons',
  'lists',
  'images',
  'speakers',
  'subtitles',
  'topics',
  'transcriptions',
  'lists/123/listItems',
  'sermons/123/sermonLists',
];
const firebaseCollectionGroups: string[] = ['listItems', 'sermonLists'];
const PROJECT_ID = 'urm-app';
const FIREBASE_JSON = resolve(__dirname, '../firebase.json');

beforeAll(async () => {
  // Silence expected rules rejections from Firestore SDK. Unexpected rejections
  // will still bubble up and will be thrown as an error (failing the tests).
  setLogLevel('error');
  const { host, port } = getFirestoreCoverageMeta(PROJECT_ID, FIREBASE_JSON);

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host,
      port,
      rules: readFileSync('firestore.rules', 'utf8'),
    },
  });
  adminDB = testEnv.authenticatedContext('adminId', { role: 'admin' }).firestore();
  uploaderDB = testEnv.authenticatedContext('uploaderId', { role: 'uploader' }).firestore();
  userDB = testEnv.authenticatedContext('userId', { role: 'user' }).firestore();
  unauthorizedDB = testEnv.unauthenticatedContext().firestore();
});

afterAll(async () => {
  // Write the coverage report to a file
  const { coverageUrl } = getFirestoreCoverageMeta(PROJECT_ID, FIREBASE_JSON);
  const coverageFile = './firestore-coverage.html';
  const fstream = createWriteStream(coverageFile);
  await new Promise((resolve, reject) => {
    get(coverageUrl, (res) => {
      res.pipe(fstream, { end: true });
      res.on('end', resolve);
      res.on('error', reject);
    });
  });
  // eslint-disable-next-line no-console
  console.log(`View firestore rule coverage information at ${coverageFile}\n`);
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe('Admin Profile', () => {
  firebaseCollections.forEach((collection) => {
    test(`Read all ${collection}`, async function () {
      await assertSucceeds(adminDB.doc(`${collection}/123`).get());
    });
    test(`Write to all ${collection}`, async function () {
      await assertSucceeds(adminDB.doc(`${collection}/123`).set({ title: 'test sermon' }));
      await assertSucceeds(adminDB.doc(`${collection}/123`).set({ title: 'test sermon' }));
    });
    test(`Delete all ${collection}`, async function () {
      await assertSucceeds(adminDB.doc(`${collection}/123`).delete());
    });
  });
  firebaseCollectionGroups.forEach((collectionGroupId) => {
    test(`[CollectionGroup]: Read all ${collectionGroupId}`, async function () {
      await assertSucceeds(adminDB.collectionGroup(collectionGroupId).where('id', '==', '123').get());
    });
  });
});

describe('Uploader Profile', () => {
  test('Read sermon only if uploaderId matches', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await securityRulesDisabledDB.doc('sermons/matchingId').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        dateMillis: serverTimestamp(),
      });
      await securityRulesDisabledDB.doc('sermons/notMatchingId').set({
        uploaderId: 'notMatchingId',
        title: 'test sermon',
        dateMillis: serverTimestamp(),
      });
    });
    await assertSucceeds(uploaderDB.doc('sermons/matchingId').get());
    await assertFails(uploaderDB.doc('sermons/notMatchingId').get());
  });

  test('Read sermon if non existent', async function () {
    await assertSucceeds(uploaderDB.doc('sermons/123').get());
  });

  test('Create sermon', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await assertSucceeds(uploaderDB.doc('sermons/matchingId').set({ uploaderId: 'uploaderId' }));
  });

  test('Update sermon only if uploaderId matches', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await securityRulesDisabledDB.doc('sermons/matchingId').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'NOT_UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
        dateMillis: serverTimestamp(),
      });
      await securityRulesDisabledDB.doc('sermons/notMatchingId').set({
        uploaderId: 'notMatchingId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'NOT_UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
        dateMillis: serverTimestamp(),
      });
    });
    await assertSucceeds(uploaderDB.doc('sermons/matchingId').set({ title: 'Edited Title' }));
    await assertFails(uploaderDB.doc('sermons/notMatchingId').set({ title: 'Edited Title' }));
  });

  test('Update sermon only if not published to Soundcloud or Subsplash', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await securityRulesDisabledDB.doc('sermons/uploadedToBoth').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'UPLOADED',
        },
      });
      await securityRulesDisabledDB.doc('sermons/uploadedToSoundCloud').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
      await securityRulesDisabledDB.doc('sermons/uploadedToSubsplash').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
      await securityRulesDisabledDB.doc('sermons/notUploaded').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'NOT_UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
    });
    await assertSucceeds(uploaderDB.doc('sermons/notUploaded').set({ title: 'Edited Title' }));
    await assertFails(uploaderDB.doc('sermons/uploadedToBoth').set({ title: 'Edited Title' }));
    await assertFails(uploaderDB.doc('sermons/uploadedToSoundCloud').set({ title: 'Edited Title' }));
    await assertFails(uploaderDB.doc('sermons/uploadedToSubsplash').set({ title: 'Edited Title' }));
  });
  test('Delete sermon only if not published to Soundcloud or Subsplash', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await securityRulesDisabledDB.doc('sermons/uploadedToBoth').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'UPLOADED',
        },
      });
      await securityRulesDisabledDB.doc('sermons/uploadedToSoundCloud').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
      await securityRulesDisabledDB.doc('sermons/uploadedToSubsplash').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
      await securityRulesDisabledDB.doc('sermons/notUploaded').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'NOT_UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
    });
    await assertSucceeds(uploaderDB.doc('sermons/notUploaded').delete());
    await assertFails(uploaderDB.doc('sermons/uploadedToBoth').delete());
    await assertFails(uploaderDB.doc('sermons/uploadedToSoundCloud').delete());
    await assertFails(uploaderDB.doc('sermons/uploadedToSubsplash').delete());
  });
});

describe('User Profile', () => {
  test('No access to all sermons', async function () {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await securityRulesDisabledDB.doc('sermons/existingSermon').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        dateMillis: serverTimestamp(),
      });
    });
    await assertFails(userDB.doc('sermons/existingSermon').get());
  });

  test('No write to all sermons', async function () {
    await assertFails(userDB.doc('sermons/123').set({ title: 'test sermon' }));
  });
});

describe('Unauthroized Profile', () => {
  test('No access any collection', async function () {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await securityRulesDisabledDB.doc('sermons/existingSermon').set({
        uploaderId: 'uploaderId',
        title: 'test sermon',
        dateMillis: serverTimestamp(),
      });
    });
    await assertFails(unauthorizedDB.doc('sermons/existingSermon').get());
    await assertFails(unauthorizedDB.doc('foo/123').get());
    await assertFails(unauthorizedDB.doc('sermons/123/sermonLists/123').get());
    await assertFails(unauthorizedDB.doc('users/123').get());
  });

  test('No write to any collection', async function () {
    await assertFails(unauthorizedDB.doc('sermons/123').set({ title: 'test sermon' }));
    await assertFails(unauthorizedDB.doc('foo/123').set({ title: 'test sermon' }));
    await assertFails(unauthorizedDB.doc('list/123').set({ title: 'test sermon' }));
  });
});
