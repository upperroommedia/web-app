import { firestore, logger } from 'firebase-functions';
import { firestore as firestoreAdmin } from 'firebase-admin';
import { Sermon } from '../../types/SermonTypes';
import { firestoreAdminSeriesConverter, firestoreAdminSermonConverter } from './firestoreDataConverter';

const sermonWriteTrigger = firestore.document('sermon/{sermonId}').onWrite(async (change, context) => {
  const { sermonId } = context.params;
  const sermonBefore = change.before.data() as Sermon | undefined;
  const sermonAfter = change.after.data() as Sermon | undefined;
  try {
    return await firestoreAdmin().runTransaction(async (transaction) => {
      if (sermonBefore && sermonAfter) {
        // Update
        logger.info(`Sermon ${sermonId} updated`);
        // get all sermons in Sermon
        await Promise.all(
          sermonAfter.series.map(async (series) => {
            const seriesRef = firestoreAdmin()
              .collection('sermons')
              .doc(series.id)
              .withConverter(firestoreAdminSeriesConverter);
            const seriesDoc = await transaction.get(seriesRef);
            const seriesData = seriesDoc.data();
            if (seriesData) {
              const allSermonsIndex = seriesData.allSermons.findIndex((sermon) => sermon.key === sermonId);
              const sermonsInSubsplashIndex = seriesData.sermonsInSubsplash.findIndex(
                (sermon) => sermon.key === sermonId
              );
              if (allSermonsIndex > -1) {
                seriesData.allSermons[allSermonsIndex] = sermonAfter;
              }
              if (sermonsInSubsplashIndex > -1) {
                seriesData.sermonsInSubsplash[sermonsInSubsplashIndex] = sermonAfter;
              }
              if (allSermonsIndex > -1 || sermonsInSubsplashIndex > -1) {
                // update Sermon in series
                transaction.update(seriesRef, {
                  ...(allSermonsIndex > -1 && { allSermons: seriesData.allSermons }),
                  ...(sermonsInSubsplashIndex > -1 && { sermonsInSubsplash: seriesData.sermonsInSubsplash }),
                });
              }
            }
          })
        );
      } else if (sermonAfter) {
        // Create
        logger.info(`Sermon ${sermonId} created`);
      } else if (sermonBefore) {
        // Delete
        logger.info(`Sermon ${sermonId} deleted`);
        await Promise.all(
          sermonBefore.series.map(async (series) => {
            const seriesRef = firestoreAdmin()
              .collection('sermons')
              .doc(series.id)
              .withConverter(firestoreAdminSeriesConverter);
            const firestoreSeries = (await transaction.get(seriesRef)).data();
            if (firestoreSeries) {
              transaction.update(seriesRef, {
                sermonsInSubsplash: firestoreSeries.sermonsInSubsplash.filter((s) => s.key !== sermonId),
                allSermons: firestoreSeries.allSermons.filter((s) => s.key !== sermonId),
              });
            }
          })
        );
      }
    });
  } catch (error) {
    logger.error(error);
  }
});

export default sermonWriteTrigger;
