import { DocumentData, QuerySnapshot } from 'firebase-admin/firestore';
import { firestore, logger } from 'firebase-functions/v2';
import { isEqual } from 'lodash';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { Sermon } from '@upperroom/shared/types/SermonTypes';
import handleError from '../../handleError';
import { algoliaSecretsWithRuntimeAlerts } from '../../algoliaSecrets';
import { waitForSermonToReachAlgolia } from '../../algoliaSyncSermon';

const firestoreAdmin = firebaseAdmin.firestore();

interface SearchSyncFields {
  searchPending?: boolean;
  searchIndexedAtMillis?: number;
  searchSyncError?: string;
}

type SermonWithSearchSync = Sermon & SearchSyncFields;

const stripNonPropagatedFields = (sermon: SermonWithSearchSync) => {
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    numberOfLists: _numberOfLists,
    numberOfListsUploadedTo: _numberOfListsUploadedTo,
    searchPending: _searchPending,
    searchIndexedAtMillis: _searchIndexedAtMillis,
    searchSyncError: _searchSyncError,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...rest
  } = sermon;

  return rest;
};

async function acknowledgeAlgoliaSync({
  sermonId,
  sermonAfter,
}: {
  sermonId: string;
  sermonAfter: SermonWithSearchSync;
}) {
  if (!sermonAfter.searchPending) {
    return;
  }

  const targetEditedAtMillis = sermonAfter.editedAtMillis;
  const indexed = await waitForSermonToReachAlgolia({
    sermonId,
    editedAtMillis: targetEditedAtMillis,
  });
  const sermonRef = firestoreAdmin.doc(`sermons/${sermonId}`);
  const latestSnapshot = await sermonRef.get();

  if (!latestSnapshot.exists) {
    return;
  }

  const latestData = latestSnapshot.data() as SermonWithSearchSync;
  if (latestData.editedAtMillis !== targetEditedAtMillis) {
    logger.info('Skipping Algolia sync acknowledgement because a newer sermon version exists.', {
      sermonId,
      targetEditedAtMillis,
      latestEditedAtMillis: latestData.editedAtMillis,
    });
    return;
  }

  if (indexed) {
    await sermonRef.update({
      searchPending: false,
      searchIndexedAtMillis: Date.now(),
      searchSyncError: firebaseAdmin.firestore.FieldValue.delete(),
    });
    return;
  }

  await sermonRef.update({
    searchSyncError: 'Timed out waiting for Algolia to index the latest sermon version.',
  });
}

async function handleDelete(
  seriesSermonSnapshot: QuerySnapshot<DocumentData>,

  sermonId: string
) {
  // Delete
  logger.info(`Sermon ${sermonId} deleted`);

  // remove sermon from any series
  const batch = firestoreAdmin.batch();
  seriesSermonSnapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  // remove all nested collections
  await firestoreAdmin.recursiveDelete(firestoreAdmin.doc(`sermons/${sermonId}`));
}

const sermonWriteTrigger = firestore.onDocumentWritten(
  { document: 'sermons/{sermonId}', secrets: algoliaSecretsWithRuntimeAlerts },
  async (event) => {
  const { sermonId } = event.params;

  const sermonBefore = event.data?.before.data() as SermonWithSearchSync | undefined;
  const sermonAfter = event.data?.after.data() as SermonWithSearchSync | undefined;
  let sermonBeforeNoCounts: Sermon | undefined = undefined;
  let sermonAfterNoCounts: Sermon | undefined = undefined;
  if (sermonBefore) {
    sermonBeforeNoCounts = stripNonPropagatedFields(sermonBefore);
  }
  if (sermonAfter) {
    sermonAfterNoCounts = stripNonPropagatedFields(sermonAfter);
  }
  try {
    const seriesSermonSnapshot = await firestoreAdmin.collectionGroup('listItems').where('id', '==', sermonId).get();
    if (sermonBefore && sermonAfter) {
      if (isEqual(sermonBeforeNoCounts, sermonAfterNoCounts)) {
        logger.info(
          'Sermon numberOfLists or numberOfListsUploadedTo was the only updated which does not need to propogate. Not updating list items to save on function calls'
        );
        return;
      }
      // Update
      logger.info(`Sermon ${sermonId} updated`);
      // get all sermons in Sermon
      const batch = firestoreAdmin.batch();
      seriesSermonSnapshot.docs.forEach((doc) => {
        batch.update(doc.ref, { ...sermonAfterNoCounts });
      });
      await batch.commit();
      await acknowledgeAlgoliaSync({ sermonId, sermonAfter });
      return;
    } else if (sermonAfter) {
      // Create
      logger.info(`Sermon ${sermonId} created`);
      await acknowledgeAlgoliaSync({ sermonId, sermonAfter });
      return;
    } else if (sermonBefore) {
      logger.info(`Sermon ${sermonId} deleted`);
      return handleDelete(seriesSermonSnapshot, sermonId);
    }
  } catch (error) {
    throw handleError(error);
  }
});

export default sermonWriteTrigger;
