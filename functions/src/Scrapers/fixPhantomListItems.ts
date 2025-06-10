import { onRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { Topic } from '../../../types/Topic';
import { List, ListType, OverflowBehavior } from '../../../types/List';
import { Sermon } from '../../../types/SermonTypes';
import { emptyList } from '../../../types/List';
import { authenticateSubsplash, createAxiosConfig } from '../subsplashUtils';
import axios from 'axios';
import { isDevelopment } from '../../../firebase/firebase';


// Helper function to update Subsplash with new sermon topics
const updateSubsplashSermonTopics = async (sermon: Sermon): Promise<void> => {
    if (//!sermon.subsplashId || 
        !sermon.topics?.length) {
        return;
    }

    logger.log(`Updating Subsplash sermon ${sermon.subsplashId} with topics: ${sermon.topics.join(', ')}`);

    try {

        // Create tags array including existing speaker tags and new topic tags
        let tags: string[] = [];

        // Add speaker tags
        if (sermon.speakers && sermon.speakers.length > 0) {
            tags = tags.concat(sermon.speakers.map((speaker) => `speaker:${speaker.name}`));
        }

        // Add topic tags (including existing ones plus new ones)
        const allTopics = [...new Set([...(sermon.topics)])]; // Remove duplicates
        if (allTopics.length > 10) {
            logger.warn(`Sermon ${sermon.id} has more than 10 topics, truncating to 10 for Subsplash`);
            allTopics.splice(10);
        }
        tags = tags.concat(allTopics.map((topic: string) => `topic:${topic}`));

        const requestData = JSON.stringify({
            app_key: '9XTSHD',
            ...(tags.length > 0 && { tags: tags }),
        });

        const bearerToken = await authenticateSubsplash();
        const config = createAxiosConfig(
            `https://core.subsplash.com/media/v1/media-items/${sermon.subsplashId}`,
            bearerToken,
            'PATCH',
            requestData
        );
        logger.log(`Request data: ${requestData}`);
        await axios(config);
        logger.log(`Successfully updated Subsplash sermon ${sermon.subsplashId} with topics`);

    } catch (error) {
        logger.error(`Failed to update Subsplash sermon ${sermon.subsplashId}:`, error);
        // Don't throw - we want the main process to continue even if Subsplash update fails
    }
};

export const fixPhantomListItems = onRequest({ cors: true }, async (req, res) => {
    const db = firebaseAdmin.firestore();

    // Check if we should update Subsplash (default to false for safety)
    const updateSubsplash = !isDevelopment;
    logger.log(`Subsplash updates: ${updateSubsplash ? 'ENABLED' : 'DISABLED'}`);

    try {
        logger.log('Starting phantom listItems cleanup...');

        // Step 1: Query all topics
        logger.log('Step 1: Querying all topics...');
        const topicsSnapshot = await db.collection('topics').get();
        const topics: Topic[] = [];
        const topicMap = new Map<string, Topic>();

        topicsSnapshot.forEach(doc => {
            const topic: Topic = { id: doc.id, ...doc.data() } as Topic;
            topics.push(topic);
            topicMap.set(topic.id, topic);
        });

        logger.log(`Found ${topics.length} topics`);

        // Step 2: Create lists for topics that don't have them
        logger.log('Step 2: Creating lists for topics without associated lists...');
        let batch = db.batch();
        let batchCount = 0;
        const MAX_BATCH_SIZE = 500;

        for (const topic of topics) {
            if (!topic.listId) {
                // Create a new list for this topic
                const newListId = db.collection('lists').doc().id;
                const newList: List = {
                    ...emptyList,
                    id: newListId,
                    name: topic.title,
                    type: ListType.TOPIC_LIST,
                    overflowBehavior: OverflowBehavior.CREATENEWLIST,
                    images: topic.images || [],
                    createdAtMillis: new Date().getTime(),
                    updatedAtMillis: new Date().getTime(),
                };

                // Add list creation to batch
                batch.set(db.collection('lists').doc(newListId), newList);

                // Update topic with listId
                batch.update(db.collection('topics').doc(topic.id), { listId: newListId });

                // Update our local topic data
                topic.listId = newListId;

                batchCount += 2; // Two operations per topic

                // Commit batch if we're approaching the limit
                if (batchCount >= MAX_BATCH_SIZE) {
                    await batch.commit();
                    logger.log(`Committed batch of ${batchCount} operations`);
                    batch = db.batch(); // Create new batch
                    batchCount = 0;
                }
            }
        }

        // Commit any remaining operations
        if (batchCount > 0) {
            await batch.commit();
            logger.log(`Committed final batch of ${batchCount} operations`);
        }

        logger.log('Step 2 completed: All topics now have associated lists');

        // Step 3: Process sermons and fix phantom listItems
        logger.log('Step 3: Processing sermons and fixing phantom listItems...');

        // Get all sermons ordered by createdAtMillis desc
        const sermonsSnapshot = await db.collection('sermons')
            .orderBy('createdAtMillis', 'desc')
            .get();

        logger.log(`Found ${sermonsSnapshot.size} sermons to process`);

        let processedCount = 0;
        let migrationBatch = db.batch();
        let migrationBatchCount = 0;
        let subsplashUpdatesCount = 0;
        for (const sermonDoc of sermonsSnapshot.docs) {
            const sermon: Sermon = { id: sermonDoc.id, ...sermonDoc.data() } as Sermon;

            // Query listItems collectionGroup for this sermon ID
            const listItemsSnapshot = await db.collectionGroup('listItems')
                .where('id', '==', sermon.id)
                .get();
            logger.log(`List items snapshot: ${listItemsSnapshot.docs.length} for sermon: ${sermon.title}`);
            if (!listItemsSnapshot.empty) {
                const topicsToAdd: string[] = [];
                const phantomPaths: string[] = [];

                // Check each found listItem document
                for (const listItemDoc of listItemsSnapshot.docs) {
                    const docPath = listItemDoc.ref.path;
                    logger.log(`Processing path: ${docPath} `);

                    // Extract the list ID from the path (lists/{listId}/listItems/{sermonId})
                    const pathParts = docPath.split('/');
                    if (pathParts.length >= 4 && pathParts[0] === 'lists' && pathParts[2] === 'listItems') {
                        const phantomListId = pathParts[1];
                        // Check if this phantom list ID is actually a topic ID
                        const topic = topicMap.get(phantomListId);
                        if (topic && topic.listId) {
                            logger.log(`Found phantom listItem for topic: ${topic.title} (${topic.id})`);

                            // Add topic title to topics array (if not already there)
                            if (!topicsToAdd.includes(topic.title)) {
                                topicsToAdd.push(topic.title);
                            }

                            // Get the sermon data from the phantom location
                            const sermonData = listItemDoc.data();

                            // Add sermon to correct list location
                            const correctListItemRef = db.collection('lists')
                                .doc(topic.listId)
                                .collection('listItems')
                                .doc(sermon.id);

                            migrationBatch.set(correctListItemRef, sermonData);

                            // Mark phantom document for deletion
                            migrationBatch.delete(listItemDoc.ref);

                            phantomPaths.push(docPath);
                            migrationBatchCount += 2; // One set, one delete
                        }
                    }
                }

                // Update sermon with new topics if any were found
                if (topicsToAdd.length > 0) {
                    const currentTopics = sermon.topics || [];
                    const updatedTopics = [...new Set([...currentTopics, ...topicsToAdd])]; // Remove duplicates

                    migrationBatch.update(db.collection('sermons').doc(sermon.id), {
                        topics: updatedTopics
                    });
                    migrationBatchCount++;

                    logger.log(`Sermon ${sermon.id}: Added topics [${topicsToAdd.join(', ')}], moved from phantom paths: [${phantomPaths.join(', ')}]`);

                    // Update Subsplash if enabled
                    if (updateSubsplash) {
                        // Update the sermon object with new topics for Subsplash call
                        const updatedSermon = { ...sermon, topics: updatedTopics };
                        await updateSubsplashSermonTopics(updatedSermon);
                        subsplashUpdatesCount++;
                    }
                }
            }

            processedCount++;

            // Commit batch if approaching limit
            if (migrationBatchCount >= MAX_BATCH_SIZE) {
                await migrationBatch.commit();
                logger.log(`Migration batch committed: ${migrationBatchCount} operations`);
                migrationBatch = db.batch(); // Create new batch
                migrationBatchCount = 0;
            }

            // Log progress every 50 sermons
            if (processedCount % 50 === 0) {
                logger.log(`Processed ${processedCount}/${sermonsSnapshot.size} sermons`);
            }
        }

        // Commit any remaining migration operations
        if (migrationBatchCount > 0) {
            await migrationBatch.commit();
            logger.log(`Final migration batch committed: ${migrationBatchCount} operations`);
        }

        logger.log(`Step 3 completed: Processed ${processedCount} sermons`);

        const result = {
            success: true,
            message: 'Phantom listItems cleanup completed successfully',
            stats: {
                topicsProcessed: topics.length,
                sermonsProcessed: processedCount,
                listsCreated: topics.filter(t => !t.listId).length,
                subsplashUpdatesEnabled: updateSubsplash,
                subsplashUpdatesCount: subsplashUpdatesCount
            }
        };

        logger.log('Cleanup completed:', result);
        res.status(200).json(result);

    } catch (error) {
        logger.error('Error during phantom listItems cleanup:', error);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            message: 'Failed to complete phantom listItems cleanup'
        });
    }
}); 