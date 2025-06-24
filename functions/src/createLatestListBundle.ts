import { onRequest } from 'firebase-functions/v2/https';
import { createBundleHandler } from './utils/bundleCreationUtils';
import { LATEST_LIST_BUNDLE_CONFIG } from '../../shared/bundleConfigs';

export const createLatestListBundle = onRequest(
  {
    timeoutSeconds: 60,
    memory: '512MiB',
    cors: true,
  },
  async (request, response) => {
    await createBundleHandler(LATEST_LIST_BUNDLE_CONFIG, request, response);
  }
);
