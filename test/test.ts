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
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  setLogLevel,
  deleteDoc,
  collectionGroup,
  query,
  getDocs,
  where,
} from 'firebase/firestore';
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
      await assertSucceeds(getDoc(doc(adminDB, `${collection}/123`)));
    });
    test(`Write to all ${collection}`, async function () {
      await assertSucceeds(setDoc(doc(adminDB, `${collection}/123`), { title: 'test sermon' }));
      await assertSucceeds(setDoc(doc(adminDB, `${collection}/123`), { title: 'test sermon' }));
    });
    test(`Delete all ${collection}`, async function () {
      await assertSucceeds(deleteDoc(doc(adminDB, `${collection}/123`)));
    });
  });
  firebaseCollectionGroups.forEach((collectionGroupId) => {
    test(`[CollectionGroup]: Read all ${collectionGroupId}`, async function () {
      await assertSucceeds(getDocs(query(collectionGroup(adminDB, collectionGroupId), where('id', '==', '123'))));
    });
  });
});

describe('Uploader Profile', () => {
  test('Read sermon only if uploaderId matches', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await setDoc(doc(securityRulesDisabledDB, 'sermons/matchingId'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        dateMillis: serverTimestamp(),
      });
      await setDoc(doc(securityRulesDisabledDB, 'sermons/notMatchingId'), {
        uploaderId: 'notMatchingId',
        title: 'test sermon',
        dateMillis: serverTimestamp(),
      });
    });
    await assertSucceeds(getDoc(doc(uploaderDB, 'sermons/matchingId')));
    await assertFails(getDoc(doc(uploaderDB, 'sermons/notMatchingId')));
  });

  test('Read sermon if non existent', async function () {
    await assertSucceeds(getDoc(doc(uploaderDB, 'sermons/123')));
  });

  test('Create sermon', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await assertSucceeds(setDoc(doc(uploaderDB, 'sermons/matchingId'), { uploaderId: 'uploaderId' }));
  });

  test('Update sermon only if uploaderId matches', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await setDoc(doc(securityRulesDisabledDB, 'sermons/matchingId'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'NOT_UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
        dateMillis: serverTimestamp(),
      });
      await setDoc(doc(securityRulesDisabledDB, 'sermons/notMatchingId'), {
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
    await assertSucceeds(setDoc(doc(uploaderDB, 'sermons/matchingId'), { title: 'Edited Title' }));
    await assertFails(setDoc(doc(uploaderDB, 'sermons/notMatchingId'), { title: 'Edited Title' }));
  });

  test('Update sermon only if not published to Soundcloud or Subsplash', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await setDoc(doc(securityRulesDisabledDB, 'sermons/uploadedToBoth'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'UPLOADED',
        },
      });
      await setDoc(doc(securityRulesDisabledDB, 'sermons/uploadedToSoundCloud'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
      await setDoc(doc(securityRulesDisabledDB, 'sermons/uploadedToSubsplash'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
      await setDoc(doc(securityRulesDisabledDB, 'sermons/notUploaded'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'NOT_UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
    });
    await assertSucceeds(setDoc(doc(uploaderDB, 'sermons/notUploaded'), { title: 'Edited Title' }));
    await assertFails(setDoc(doc(uploaderDB, 'sermons/uploadedToBoth'), { title: 'Edited Title' }));
    await assertFails(setDoc(doc(uploaderDB, 'sermons/uploadedToSoundCloud'), { title: 'Edited Title' }));
    await assertFails(setDoc(doc(uploaderDB, 'sermons/uploadedToSubsplash'), { title: 'Edited Title' }));
  });
  test('Delete sermon only if not published to Soundcloud or Subsplash', async function () {
    // add a sermon with uploaderId uploaderId to the database
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await setDoc(doc(securityRulesDisabledDB, 'sermons/uploadedToBoth'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'UPLOADED',
        },
      });
      await setDoc(doc(securityRulesDisabledDB, 'sermons/uploadedToSoundCloud'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
      await setDoc(doc(securityRulesDisabledDB, 'sermons/uploadedToSubsplash'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
      await setDoc(doc(securityRulesDisabledDB, 'sermons/notUploaded'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        status: {
          audioStatus: 'PROCESSED',
          soundCloud: 'NOT_UPLOADED',
          subsplash: 'NOT_UPLOADED',
        },
      });
    });
    await assertSucceeds(deleteDoc(doc(uploaderDB, 'sermons/notUploaded')));
    await assertFails(deleteDoc(doc(uploaderDB, 'sermons/uploadedToBoth')));
    await assertFails(deleteDoc(doc(uploaderDB, 'sermons/uploadedToSoundCloud')));
    await assertFails(deleteDoc(doc(uploaderDB, 'sermons/uploadedToSubsplash')));
  });
});

describe('User Profile', () => {
  test('No access to all sermons', async function () {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await setDoc(doc(securityRulesDisabledDB, 'sermons/existingSermon'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        dateMillis: serverTimestamp(),
      });
    });
    await assertFails(getDoc(doc(userDB, 'sermons/existingSermon')));
  });

  test('No write to all sermons', async function () {
    await assertFails(setDoc(doc(userDB, 'sermons/123'), { title: 'test sermon' }));
  });
});

describe('Unauthroized Profile', () => {
  test('No access any collection', async function () {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const securityRulesDisabledDB = context.firestore();
      await setDoc(doc(securityRulesDisabledDB, 'sermons/existingSermon'), {
        uploaderId: 'uploaderId',
        title: 'test sermon',
        dateMillis: serverTimestamp(),
      });
    });
    await assertFails(getDoc(doc(unauthorizedDB, 'sermons/existingSermon')));
    await assertFails(getDoc(doc(unauthorizedDB, 'foo/123')));
    await assertFails(getDoc(doc(unauthorizedDB, 'sermons/123/sermonLists/123')));
    await assertFails(getDoc(doc(unauthorizedDB, 'users/123')));
  });

  test('No write to any collection', async function () {
    await assertFails(setDoc(doc(unauthorizedDB, 'sermons/123'), { title: 'test sermon' }));
    await assertFails(setDoc(doc(unauthorizedDB, 'foo/123'), { title: 'test sermon' }));
    await assertFails(setDoc(doc(unauthorizedDB, 'list/123'), { title: 'test sermon' }));
  });
});
