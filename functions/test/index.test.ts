import 'jest';
import functions from 'firebase-functions-test';
import * as admin from 'firebase-admin';
import { resolve } from 'path';
import { getFirestoreCoverageMeta } from '../../test/utils';
import { firestoreAdminSermonConverter } from '../src/firestoreDataConverter';
import { logger } from 'firebase-functions/v2';
import { createEmptySermon } from '../../types/Sermon';
import { Change } from 'firebase-functions';
import { FirestoreEvent } from 'firebase-functions/v2/firestore';

// import { stub } from 'sinon';

// We start FirebaseFunctionsTest offline
const testEnv = functions();
const PROJECT_ID = 'urm-app';
const FIREBASE_JSON = resolve(__dirname, '../../firebase.json');
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { host, port } = getFirestoreCoverageMeta(PROJECT_ID, FIREBASE_JSON);
process.env.FIRESTORE_EMULATOR_HOST = `${host}:${port}`;
admin.initializeApp({ projectId: PROJECT_ID });
const firestoreDB = admin.firestore();
import sermonWriteTrigger from '../src/DocumentListeners/Sermons/sermonWriteTrigger';
const sermonWriteTriggerWrapped = testEnv.wrap(sermonWriteTrigger);
type SermonWriteTriggerParameter = Parameters<typeof sermonWriteTriggerWrapped>[0];

describe('Functions Test Suite', () => {
  let mockLog: jest.SpyInstance<void, unknown[], unknown>;
  beforeEach(async () => {
    await testEnv.firestore.clearFirestoreData({ projectId: PROJECT_ID });
    mockLog = jest.spyOn(logger, 'info').mockImplementation();
  });

  test('SermonWriteTrigger', async () => {
    const sermonsRef = firestoreDB.collection('sermons').withConverter(firestoreAdminSermonConverter);
    const emptyDocument = await sermonsRef.doc('doesNotExist').get();
    const changeEventBaseParams: SermonWriteTriggerParameter = {
      location: '',
      project: '',
      database: '',
      namespace: '',
      document: '',
      specversion: '1.0',
      id: '',
      source: '',
      type: '',
      time: '',
    };

    const data = createEmptySermon();
    const sermonRef = sermonsRef.doc(data.id);
    await sermonRef.create(data);
    const docCreatedSnap = await sermonRef.get();
    const changeEvent: SermonWriteTriggerParameter = {
      ...changeEventBaseParams,
      data: new Change(emptyDocument, docCreatedSnap),
      params: { sermonId: data.id },
    };

    await sermonWriteTriggerWrapped(changeEvent);
    expect(mockLog).toHaveBeenCalledWith(`Sermon ${data.id} created`);
    mockLog.mockClear();

    //update numberOfLists
    await sermonRef.update({ numberOfLists: 100 });
    const docNumberOfListsUpdatedSnap = await sermonRef.get();
    const updatedNumberOfListsChangeEvent: SermonWriteTriggerParameter = {
      ...changeEventBaseParams,
      data: new Change(docCreatedSnap, docNumberOfListsUpdatedSnap),
      params: { sermonId: data.id },
    };
    await sermonWriteTriggerWrapped(updatedNumberOfListsChangeEvent);
    expect(mockLog).toHaveBeenCalledWith(
      'Sermon numberOfLists or numberOfListsUploadedTo was the only updated which does not need to propogate. Not updating list items to save on function calls'
    );
  });
});
