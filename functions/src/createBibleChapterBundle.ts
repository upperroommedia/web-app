import { onRequest } from 'firebase-functions/v2/https';
import { createBundleHandler } from './utils/bundleCreationUtils';
import { BIBLE_CHAPTER_BUNDLE_CONFIG } from '@upperroom/shared/shared/bundleConfigs';

export const createBibleChapterBundle = onRequest(
    {
        timeoutSeconds: 60,
        memory: '512MiB',
        cors: true
    },
    async (request, response) => {
        await createBundleHandler(BIBLE_CHAPTER_BUNDLE_CONFIG, request, response);
    }
);
