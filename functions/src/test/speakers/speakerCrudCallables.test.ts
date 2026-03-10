import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import createspeaker from '../../speakers/createSpeaker';
import updatespeaker from '../../speakers/updateSpeaker';
import deletespeaker from '../../speakers/deleteSpeaker';
import { firestoreAdminListConverter, firestoreAdminSpeakerConverter } from '../../firestoreDataConverter';
import {
  CreateSpeakerCallableInputType,
  CreateSpeakerCallableOutputType,
  DeleteSpeakerCallableInputType,
  DeleteSpeakerCallableOutputType,
  UpdateSpeakerCallableInputType,
  UpdateSpeakerCallableOutputType,
} from '../../speakers/createSpeakerTypes';
import { createNewSubsplashList } from '../../createNewSubsplashList';
import { ImageType } from '../../../../types/Image';
import { ListType, OverflowBehavior } from '../../../../types/List';

jest.mock('firebase-functions/v2/https', () => {
  const actual = jest.requireActual('firebase-functions/v2/https');
  return {
    ...actual,
    onCall: jest.fn((optsOrHandler: unknown, maybeHandler?: unknown) =>
      (typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler)
    ),
  };
});

jest.mock('../../createNewSubsplashList', () => ({
  __esModule: true,
  default: jest.fn(),
  createNewSubsplashList: jest.fn(async () => ({ listId: 'subsplash-list-1' })),
}));

type CallableAuthType = {
  uid?: string;
  token?: {
    role?: string;
  };
};

type TestRequestType<T> = {
  auth?: CallableAuthType;
  data: T;
};

const firestore = firebaseAdmin.firestore();
const speakersCollection = firestore.collection('speakers').withConverter(firestoreAdminSpeakerConverter);
const listsCollection = firestore.collection('lists').withConverter(firestoreAdminListConverter);
const mockCreateNewSubsplashList = createNewSubsplashList as jest.MockedFunction<typeof createNewSubsplashList>;

const createSpeakerHandler = createspeaker as unknown as (
  request: TestRequestType<CreateSpeakerCallableInputType>
) => Promise<CreateSpeakerCallableOutputType>;
const updateSpeakerHandler = updatespeaker as unknown as (
  request: TestRequestType<UpdateSpeakerCallableInputType>
) => Promise<UpdateSpeakerCallableOutputType>;
const deleteSpeakerHandler = deletespeaker as unknown as (
  request: TestRequestType<DeleteSpeakerCallableInputType>
) => Promise<DeleteSpeakerCallableOutputType>;

const defaultAuth: CallableAuthType = {
  uid: 'admin-1',
  token: {
    role: 'admin',
  },
};

const clearCollection = async (collectionName: string): Promise<void> => {
  const snapshot = await firestore.collection(collectionName).get();
  if (snapshot.empty) {
    return;
  }

  const batch = firestore.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();
};

const createSquareImage = (id = 'img-square'): ImageType => ({
  id,
  type: 'square',
  size: 'large',
  width: 600,
  height: 600,
  downloadLink: `https://example.com/${id}.jpg`,
  name: id,
  dateAddedMillis: Date.now(),
});

const createWideImage = (id = 'img-wide'): ImageType => ({
  id,
  type: 'wide',
  size: 'large',
  width: 1600,
  height: 900,
  downloadLink: `https://example.com/${id}.jpg`,
  name: id,
  dateAddedMillis: Date.now(),
});

describe('speaker CRUD callables', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockCreateNewSubsplashList.mockResolvedValue({ listId: 'subsplash-list-1' });
    await clearCollection('speakers');
    await clearCollection('lists');
    await clearCollection('subsplashOperationKeys');
  });

  it('creates a speaker and persists expected fields', async () => {
    const result = await createSpeakerHandler({
      auth: defaultAuth,
      data: {
        speaker: {
          name: '  Speaker One  ',
          images: [createSquareImage(), createWideImage()],
        },
      },
    });

    expect(result.status).toBe('success');
    expect(result.speaker.name).toBe('Speaker One');
    expect(result.speaker.sermonCount).toBe(0);
    expect(result.speakerListCreated).toBe(false);

    const persistedSpeaker = await speakersCollection.doc(result.speakerId).get();
    expect(persistedSpeaker.exists).toBe(true);
    expect(persistedSpeaker.data()).toMatchObject({
      id: result.speakerId,
      name: 'Speaker One',
      sermonCount: 0,
    });
  });

  it('creates and associates a speaker list using the square image payload', async () => {
    const squareImage = createSquareImage('speaker-square');
    const result = await createSpeakerHandler({
      auth: defaultAuth,
      data: {
        speaker: {
          name: 'Speaker Two',
          images: [createWideImage(), squareImage],
        },
        createSpeakerList: true,
      },
    });

    expect(result.status).toBe('success');
    expect(result.speakerListCreated).toBe(true);
    expect(result.listId).toBeDefined();
    expect(result.listSubsplashId).toBe('subsplash-list-1');
    expect(mockCreateNewSubsplashList).toHaveBeenCalledWith({
      title: 'Speaker Two',
      images: [squareImage],
    });

    const persistedSpeaker = await speakersCollection.doc(result.speakerId).get();
    expect(persistedSpeaker.data()?.listId).toBe(result.listId);

    const persistedList = await listsCollection.doc(result.listId!).get();
    expect(persistedList.exists).toBe(true);
    expect(persistedList.data()).toMatchObject({
      id: result.listId,
      name: 'Speaker Two',
      type: ListType.SPEAKER_LIST,
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      subsplashId: 'subsplash-list-1',
    });
    expect(persistedList.data()?.images).toEqual([squareImage]);
  });

  it('rejects create requests without a square image', async () => {
    await expect(
      createSpeakerHandler({
        auth: defaultAuth,
        data: {
          speaker: {
            name: 'No Square',
            images: [createWideImage()],
          },
        },
      })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'A square image is required.',
    });
  });

  it('rejects update requests when selected images do not contain a square image', async () => {
    await speakersCollection.doc('speaker-update-no-square').set({
      id: 'speaker-update-no-square',
      name: 'Speaker Existing',
      images: [createSquareImage('existing-square')],
      sermonCount: 4,
      tagId: 'speaker-tag-existing',
    });

    await expect(
      updateSpeakerHandler({
        auth: defaultAuth,
        data: {
          speakerId: 'speaker-update-no-square',
          patch: {
            images: [createWideImage('updated-wide')],
          },
        },
      })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'A square image is required.',
    });
  });

  it('updates and deletes speaker state through separate callables', async () => {
    await speakersCollection.doc('speaker-crud-1').set({
      id: 'speaker-crud-1',
      name: 'Speaker Before',
      images: [createSquareImage('before-square')],
      sermonCount: 5,
      tagId: 'speaker-tag-1',
      listId: 'speaker-list-1',
    });
    await listsCollection.doc('speaker-list-1').set({
      id: 'speaker-list-1',
      name: 'Speaker Before',
      type: ListType.SPEAKER_LIST,
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      images: [createSquareImage('before-square')],
      createdAtMillis: Date.now(),
      updatedAtMillis: Date.now(),
      count: 0,
    });

    const updateResult = await updateSpeakerHandler({
      auth: defaultAuth,
      data: {
        speakerId: 'speaker-crud-1',
        patch: {
          name: 'Speaker After',
          images: [createSquareImage('after-square')],
          associatedListId: null,
        },
      },
    });

    expect(updateResult.status).toBe('success');
    expect(updateResult.speaker.id).toBe('speaker-crud-1');
    expect(updateResult.speaker.name).toBe('Speaker After');
    expect(updateResult.speaker.tagId).toBe('speaker-tag-1');
    expect(updateResult.speaker.listId).toBeUndefined();

    const updatedSpeakerDoc = await speakersCollection.doc('speaker-crud-1').get();
    expect(updatedSpeakerDoc.data()).toMatchObject({
      id: 'speaker-crud-1',
      name: 'Speaker After',
      sermonCount: 5,
      tagId: 'speaker-tag-1',
    });
    expect(updatedSpeakerDoc.data()?.listId).toBeUndefined();

    const deleteResult = await deleteSpeakerHandler({
      auth: defaultAuth,
      data: {
        speakerId: 'speaker-crud-1',
        deleteAssociatedList: true,
      },
    });
    expect(deleteResult.status).toBe('success');
    expect(deleteResult.listDeleted).toBe(false);
    expect((await speakersCollection.doc('speaker-crud-1').get()).exists).toBe(false);
    expect((await listsCollection.doc('speaker-list-1').get()).exists).toBe(true);
  });

  it('deletes associated list only when explicitly requested', async () => {
    await speakersCollection.doc('speaker-delete-list').set({
      id: 'speaker-delete-list',
      name: 'Speaker Delete',
      images: [createSquareImage('delete-square')],
      sermonCount: 1,
      listId: 'speaker-list-delete',
    });
    await listsCollection.doc('speaker-list-delete').set({
      id: 'speaker-list-delete',
      name: 'Speaker Delete',
      type: ListType.SPEAKER_LIST,
      overflowBehavior: OverflowBehavior.CREATENEWLIST,
      images: [createSquareImage('delete-square')],
      createdAtMillis: Date.now(),
      updatedAtMillis: Date.now(),
      count: 0,
    });

    const deleteResult = await deleteSpeakerHandler({
      auth: defaultAuth,
      data: {
        speakerId: 'speaker-delete-list',
        deleteAssociatedList: true,
      },
    });

    expect(deleteResult.status).toBe('success');
    expect(deleteResult.listDeleted).toBe(true);
    expect(deleteResult.deletedListId).toBe('speaker-list-delete');
    expect((await speakersCollection.doc('speaker-delete-list').get()).exists).toBe(false);
    expect((await listsCollection.doc('speaker-list-delete').get()).exists).toBe(false);
  });

  it('rejects unauthorized callers for create, update, and delete', async () => {
    await speakersCollection.doc('speaker-unauthorized').set({
      id: 'speaker-unauthorized',
      name: 'Speaker Unauthorized',
      images: [createSquareImage('unauthorized-square')],
      sermonCount: 0,
    });

    await expect(
      createSpeakerHandler({
        auth: undefined,
        data: {
          speaker: {
            name: 'No Auth Create',
            images: [createSquareImage('no-auth-create')],
          },
        },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });

    await expect(
      updateSpeakerHandler({
        auth: {
          uid: 'viewer-1',
          token: {
            role: 'user',
          },
        },
        data: {
          speakerId: 'speaker-unauthorized',
          patch: { name: 'Blocked' },
        },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });

    await expect(
      deleteSpeakerHandler({
        auth: {
          uid: 'viewer-1',
          token: {
            role: 'uploader',
          },
        },
        data: {
          speakerId: 'speaker-unauthorized',
        },
      })
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
