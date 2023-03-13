import { firestore, logger } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import { convertSeriesToSeriesSummary, Series } from '../../types/Series';
import { firestoreAdminSermonConverter } from './firestoreDataConverter';

const seriesWriteTrigger = firestore.document('series/{seriesId}').onWrite(async (change, context) => {
  const { seriesId } = context.params;
  const seriesBefore = change.before.data() as Series | undefined;
  const seriesAfter = change.after.data() as Series | undefined;
  try {
    return await firestoreAdmin().runTransaction(async (transaction) => {
      if (seriesBefore && seriesAfter) {
        // Update
        if (
          JSON.stringify(convertSeriesToSeriesSummary(seriesBefore)) ===
          JSON.stringify(convertSeriesToSeriesSummary(seriesAfter))
        ) {
          // No change
          logger.info(`Series Summary Data ${seriesId} unchanged`);
          return;
        }
        logger.info(`Series ${seriesId} updated`);
        // get all sermons in series
        await Promise.all(
          seriesAfter.allSermons.map(async (sermon) => {
            const sermonRef = firestoreAdmin()
              .collection('sermons')
              .doc(sermon.key)
              .withConverter(firestoreAdminSermonConverter);
            const sermonDoc = await transaction.get(sermonRef);
            const sermonData = sermonDoc.data();
            if (sermonData) {
              const index = sermonData.series.findIndex((series) => series.id === seriesId);
              if (index > -1) {
                // update series in sermon
                sermonData.series[index] = convertSeriesToSeriesSummary(seriesAfter);
                transaction.update(sermonRef, { series: sermonData.series });
              }
            }
          })
        );
      } else if (seriesAfter) {
        // Create
        logger.info(`Series ${seriesId} created`);
      } else if (seriesBefore) {
        // Delete
        logger.info(`Series ${seriesId} deleted`);
        await Promise.all(
          seriesBefore.allSermons.map(async (sermon) => {
            const sermonRef = firestoreAdmin()
              .collection('sermons')
              .doc(sermon.key)
              .withConverter(firestoreAdminSermonConverter);
            if (sermonRef) {
              transaction.update(sermonRef, { series: firestoreAdmin.FieldValue.arrayRemove(seriesBefore) });
            }
          })
        );
      }
    });
  } catch (error) {
    logger.error(error);
  }
});

export default seriesWriteTrigger;
