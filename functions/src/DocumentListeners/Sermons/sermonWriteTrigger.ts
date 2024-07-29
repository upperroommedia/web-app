import { DocumentData, QuerySnapshot } from 'firebase-admin/firestore';
import { firestore, logger } from 'firebase-functions/v2';
import { isEqual } from 'lodash';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import { Sermon } from '../../../../types/SermonTypes';
import handleError from '../../handleError';

const firestoreAdmin = firebaseAdmin.firestore();

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

const sermonWriteTrigger = firestore.onDocumentWritten('sermons/{sermonId}', async (event) => {
  const { sermonId } = event.params;

  const sermonBefore = event.data?.before.data() as Sermon | undefined;
  const sermonAfter = event.data?.after.data() as Sermon | undefined;
  let sermonBeforeNoCounts: Sermon | undefined = undefined;
  let sermonAfterNoCounts: Sermon | undefined = undefined;
  if (sermonBefore) {
    const {
      /* eslint-disable @typescript-eslint/no-unused-vars */
      numberOfLists: _beforeNumberOfLists,
      numberOfListsUploadedTo: _beforeNumberOfListsUploadedTo,
      /* eslint-enable @typescript-eslint/no-unused-vars */
      ...rest
    } = sermonBefore;
    sermonBeforeNoCounts = rest;
  }
  if (sermonAfter) {
    const {
      /* eslint-disable @typescript-eslint/no-unused-vars */
      numberOfLists: _afterNumberOfLists,
      numberOfListsUploadedTo: _afterNumberOfListsUploadedTo,
      /* eslint-enable @typescript-eslint/no-unused-vars */
      ...rest
    } = sermonAfter;
    sermonAfterNoCounts = rest;
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
      return batch.commit();
    } else if (sermonAfter) {
      // Create
      return logger.info(`Sermon ${sermonId} created`);
    } else if (sermonBefore) {
      logger.info(`Sermon ${sermonId} deleted`);
      return handleDelete(seriesSermonSnapshot, sermonId);
    }
  } catch (error) {
    throw handleError(error);
  }
});

export default sermonWriteTrigger;
