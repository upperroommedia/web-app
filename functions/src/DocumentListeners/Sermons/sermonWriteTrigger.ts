import { firestore, logger } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import { Sermon } from '../../../../types/SermonTypes';
import handleError from '../../handleError';

async function handleDelete(
  seriesSermonSnapshot: firestoreAdmin.QuerySnapshot<firestoreAdmin.DocumentData>,

  sermonId: string
) {
  // Delete
  logger.info(`Sermon ${sermonId} deleted`);

  // remove sermon from any series
  const batch = firestoreAdmin().batch();
  seriesSermonSnapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  // remove all nested collections
  await firestoreAdmin().recursiveDelete(firestoreAdmin().doc(`sermons/${sermonId}`));
}

const sermonWriteTrigger = firestore.document('sermons/{sermonId}').onWrite(async (change, context) => {
  const { sermonId } = context.params;
  const sermonBefore = change.before.data() as Sermon | undefined;
  const sermonAfter = change.after.data() as Sermon | undefined;
  try {
    const seriesSermonSnapshot = await firestoreAdmin()
      .collectionGroup('seriesSermons')
      .where('key', '==', sermonId)
      .get();
    const batch = firestoreAdmin().batch();
    if (sermonBefore && sermonAfter) {
      // Update
      logger.info(`Sermon ${sermonId} updated`);
      // get all sermons in Sermon
      seriesSermonSnapshot.docs.forEach((doc) => {
        batch.update(doc.ref, { ...sermonAfter });
      });
      return batch.commit();
    } else if (sermonAfter) {
      // Create
      return logger.info(`Sermon ${sermonId} created`);
    } else if (sermonBefore) {
      return handleDelete(seriesSermonSnapshot, sermonId);
    }
  } catch (error) {
    throw handleError(error);
  }
});

export default sermonWriteTrigger;
