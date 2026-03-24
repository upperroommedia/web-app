import { onRequest } from 'firebase-functions/v2/https';
import { createBundleHandler } from './utils/bundleCreationUtils';
import { SUNDAY_HOMILY_BUNDLE_CONFIG } from '@upperroom/shared/shared/bundleConfigs';

export const createSundayHomilyBundle = onRequest(
    {
        timeoutSeconds: 60,
        memory: '512MiB',
        cors: true
    },
    async (request, response) => {
        await createBundleHandler(SUNDAY_HOMILY_BUNDLE_CONFIG, request, response);
    }
);
