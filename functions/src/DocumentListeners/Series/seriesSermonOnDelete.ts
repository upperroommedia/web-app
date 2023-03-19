import { firestore, logger } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import { firestoreAdminSeriesConverter } from '../../firestoreDataConverter';
import { FieldValue } from 'firebase-admin/firestore';

const seriesSermonOnDelete = firestore
  .document('series/{seriesId}/seriesSermons/{sermonId}')
  .onDelete(async (snapshot, context) => {
    const { seriesId, sermonId } = context.params;
    // removing series from sermon if sermon still exists
    try {
      logger.info(`Removing series ${seriesId} from sermon ${sermonId}`);
      await firestoreAdmin().collection('sermons').doc(sermonId).collection('sermonSeries').doc(seriesId).delete();
    } catch (err) {
      logger.info(`Sermon ${sermonId} does not exist - skipping delete`);
    }
    try {
      logger.log('Decrementing series count');
      await firestoreAdmin()
        .collection('series')
        .doc(seriesId)
        .withConverter(firestoreAdminSeriesConverter)
        .update({ count: FieldValue.increment(-1) });
      return;
    } catch (error) {
      logger.error(`Error decrementing series count: ${error} - this can be ignored if the series was deleted`);
    }
  });

export default seriesSermonOnDelete;
