import { createAxiosConfig } from '../subsplashUtils';
import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { Sermon } from '../../../types/SermonTypes';
import { withSubsplashLocks } from '../locks/withSubsplashLocks';

// Helper function to update Subsplash with new sermon topics
const updateSubsplashSermonTopics = async (sermon: Sermon, bearerToken: string): Promise<void> => {
    if (!sermon.subsplashId ||
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

        await withSubsplashLocks([`media-item:${sermon.subsplashId}`], async () => {
            const config = createAxiosConfig(
                `https://core.subsplash.com/media/v1/media-items/${sermon.subsplashId}`,
                bearerToken,
                'PATCH',
                requestData
            );
            logger.log(`Request data: ${requestData}`);
            await axios(config);
        });
        logger.log(`Successfully updated Subsplash sermon ${sermon.subsplashId} with topics`);

    } catch (error) {
        logger.error(`Failed to update Subsplash sermon ${sermon.subsplashId}:`, error);
        // Don't throw - we want the main process to continue even if Subsplash update fails
    }
};

export default updateSubsplashSermonTopics;
