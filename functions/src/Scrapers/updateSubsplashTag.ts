import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import updateSubsplashSermonTopics from '../helpers/updateSubsplashTagsHelper';
import { Sermon } from '../../../types/SermonTypes';
import { ListType } from '../../../types/List';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { authenticateSubsplash } from '../subsplashUtils';

export const updateSubsplashTag = onRequest({ cors: true }, async (req, res) => {
    const db = firebaseAdmin.firestore();

    try {
        logger.log('Starting sermon topics update process...');

        // Get all sermons
        const sermonsSnapshot = await db.collection('sermons').orderBy('createdAtMillis', 'desc').get();
        logger.log(`Found ${sermonsSnapshot.size} sermons to process`);

        const updatedSermons: Sermon[] = [];
        let processedCount = 0;

        // Process each sermon
        for (const sermonDoc of sermonsSnapshot.docs) {
            const sermon: Sermon = { id: sermonDoc.id, ...sermonDoc.data() } as Sermon;
            const currentTopics = sermon.topics || [];
            const newTopics = [...currentTopics]; // Start with existing topics
            let hasUpdates = false;

            // Get all sermonLists for this sermon
            try {
                const sermonListsSnapshot = await db.collection('sermons')
                    .doc(sermon.id)
                    .collection('sermonLists')
                    .where('type', '==', ListType.TOPIC_LIST)
                    .get();
                logger.log(`Found ${sermonListsSnapshot.size} sermonLists for sermon ${sermon.id}`);
                // Check each sermonList entry
                for (const sermonListDoc of sermonListsSnapshot.docs) {
                    const sermonListData = sermonListDoc.data();

                    // This sermon is in this topic list, add the list title to topics if not already present
                    if (!newTopics.includes(sermonListData.name)) {
                        newTopics.push(sermonListData.name);
                        hasUpdates = true;
                    }
                }
            } catch (error) {
                logger.error(`Error checking sermonLists for sermon ${sermon.id}:`, error);
            }

            // If topics were updated, prepare for batch update
            if (hasUpdates) {
                // Only store what we need for updates - avoid spreading entire sermon object
                const updatedSermon: Sermon = {
                    ...sermon,
                    topics: newTopics
                };
                updatedSermons.push(updatedSermon);
                logger.log(`Sermon "${sermon.title}" updated with new topics: [${newTopics.join(', ')}]`);
            }

            processedCount++;
            if (processedCount % 100 === 0) {
                logger.log(`Processed ${processedCount}/${sermonsSnapshot.size} sermons`);
            }
        }

        logger.log(`Found ${updatedSermons.length} sermons that need topic updates`);

        if (updatedSermons.length === 0) {
            logger.log('No sermons need updating');
            res.status(200).json({
                success: true,
                message: 'No sermons needed topic updates',
                stats: {
                    totalSermons: sermonsSnapshot.size,
                    sermonsUpdated: 0,
                    subsplashUpdates: 0
                }
            });
            return;
        }

        // Batch update Firestore (max 500 operations per batch)
        const MAX_FIRESTORE_BATCH_SIZE = 500;
        let firestoreBatch = db.batch();
        let firestoreBatchCount = 0;
        let totalFirestoreUpdates = 0;

        for (const updatedSermon of updatedSermons) {
            // Explicitly only update the topics field to avoid touching other fields like createdAtMillis
            firestoreBatch.update(db.collection('sermons').doc(updatedSermon.id), {
                topics: updatedSermon.topics,
            });
            firestoreBatchCount++;

            if (firestoreBatchCount >= MAX_FIRESTORE_BATCH_SIZE) {
                await firestoreBatch.commit();
                logger.log(`Committed Firestore batch of ${firestoreBatchCount} updates`);
                totalFirestoreUpdates += firestoreBatchCount;
                firestoreBatch = db.batch();
                firestoreBatchCount = 0;
            }
        }

        // Commit remaining Firestore updates
        if (firestoreBatchCount > 0) {
            await firestoreBatch.commit();
            logger.log(`Committed final Firestore batch of ${firestoreBatchCount} updates`);
            totalFirestoreUpdates += firestoreBatchCount;
        }

        logger.log(`Completed ${totalFirestoreUpdates} Firestore updates`);

        // Update Subsplash in batches of 50
        const SUBSPLASH_BATCH_SIZE = 50;
        let subsplashUpdates = 0;
        const bearerToken = await authenticateSubsplash();
        for (let i = 0; i < updatedSermons.length; i += SUBSPLASH_BATCH_SIZE) {
            const batch = updatedSermons.slice(i, i + SUBSPLASH_BATCH_SIZE);

            logger.log(`Processing Subsplash batch ${Math.floor(i / SUBSPLASH_BATCH_SIZE) + 1} of ${Math.ceil(updatedSermons.length / SUBSPLASH_BATCH_SIZE)} (${batch.length} sermons)`);

            // Process batch in parallel for better performance
            const subsplashPromises = batch.map(async (sermon) => {
                try {
                    await updateSubsplashSermonTopics(sermon, bearerToken);
                    return true;
                } catch (error) {
                    logger.error(`Failed to update Subsplash for sermon ${sermon.id}:`, error);
                    return false;
                }
            });

            const results = await Promise.allSettled(subsplashPromises);
            const successCount = results.filter(result =>
                result.status === 'fulfilled' && result.value === true
            ).length;

            subsplashUpdates += successCount;
            logger.log(`Subsplash batch completed: ${successCount}/${batch.length} successful updates`);

            // Small delay between batches to avoid overwhelming Subsplash API
            if (i + SUBSPLASH_BATCH_SIZE < updatedSermons.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const result = {
            success: true,
            message: 'Sermon topics update completed successfully',
            stats: {
                totalSermons: sermonsSnapshot.size,
                sermonsUpdated: updatedSermons.length,
                firestoreUpdates: totalFirestoreUpdates,
                subsplashUpdates: subsplashUpdates
            }
        };

        logger.log('Update process completed:', result);
        res.status(200).json(result);

    } catch (error) {
        logger.error('Error during sermon topics update:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            message: 'Failed to complete sermon topics update'
        });
    }
});
