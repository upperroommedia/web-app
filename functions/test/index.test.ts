import { mockFirestoreDB, mockLogV2, PROJECT_ID, testEnv } from './jest.setup';
import { firestoreAdminSermonConverter } from '../src/firestoreDataConverter';
import { createEmptySermon } from '../../types/Sermon';
import { Change } from 'firebase-functions';

import sermonWriteTrigger from '../src/DocumentListeners/Sermons/sermonWriteTrigger';
const sermonWriteTriggerWrapped = testEnv.wrap(sermonWriteTrigger);
type SermonWriteTriggerParameter = Parameters<typeof sermonWriteTriggerWrapped>[0];

describe('Functions Test Suite', () => {
  beforeEach(async () => {
    await testEnv.firestore.clearFirestoreData({ projectId: PROJECT_ID });
  });

  test('SermonWriteTrigger', async () => {
    const sermonsRef = mockFirestoreDB.collection('sermons').withConverter(firestoreAdminSermonConverter);
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
    expect(mockLogV2).toHaveBeenCalledWith(`Sermon ${data.id} created`);
    mockLogV2.mockClear();

    //update numberOfLists
    await sermonRef.update({ numberOfLists: 100 });
    const docNumberOfListsUpdatedSnap = await sermonRef.get();
    const updatedNumberOfListsChangeEvent: SermonWriteTriggerParameter = {
      ...changeEventBaseParams,
      data: new Change(docCreatedSnap, docNumberOfListsUpdatedSnap),
      params: { sermonId: data.id },
    };
    await sermonWriteTriggerWrapped(updatedNumberOfListsChangeEvent);
    expect(mockLogV2).toHaveBeenCalledWith(
      'Sermon numberOfLists or numberOfListsUploadedTo was the only updated which does not need to propogate. Not updating list items to save on function calls'
    );
  });
});
