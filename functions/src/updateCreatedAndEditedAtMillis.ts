import { logger, https } from 'firebase-functions';
import { HttpsError } from 'firebase-functions/v2/https';
import firebaseAdmin from '../../firebase/firebaseAdmin';

const updateCreatedAndEditedAtMillis = https.onCall(async (): Promise<HttpsError | number> => {
  try {
    //gets all sermons
    logger.log('updateUploadedAtMillis called');
    const sermons = await firebaseAdmin.firestore().collection('sermons').get();
    const batch = firebaseAdmin.firestore().batch();
    let count = 0;

    //update uploadedAtMillis for each sermon that doesn't have it with dateMillis
    sermons.docs.forEach((doc) => {
      if (!doc.data().createdAtMillis) {
        logger.log(`Updating uploadedAtMillis for ${doc.id}`);
        batch.update(doc.ref, {
          createdAtMillis: doc.data().dateMillis,
          editedAtMillis: doc.data().dateMillis,
        });
        count++;
      }
      if (count > 0 && count % 500 === 0) {
        batch.commit();
      }
    });
    await batch.commit();
    return count;
  } catch (error) {
    const httpsError = new HttpsError('unknown', `${error}`);
    logger.error(httpsError);
    throw httpsError;
  }
});
export default updateCreatedAndEditedAtMillis;
