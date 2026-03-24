import { firestore, logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../handleError';
import { BundleConfig } from '@upperroom/shared/shared/bundleConfigs';
import { generateAndStoreBundle } from './bundleCreationUtils';

const database = firebaseAdmin.database();

export function createBundleDocumentListener<T>(config: BundleConfig<T>) {
  return firestore.onDocumentWritten(config.collectionPath, async (event) => {
    // Get the data from before and after
    const beforeData = event.data?.before?.data() as T | undefined;
    const afterData = event.data?.after?.data() as T | undefined;
    const dataDiff = {
      before: beforeData,
      after: afterData,
    };

    // Check if we should trigger bundle regeneration
    if (!config.shouldTrigger(beforeData, afterData)) {
      logger.info(`No changes detected for ${config.displayName} bundle, skipping regeneration.`, dataDiff);
      return;
    }

    logger.info(`Regenerating ${config.displayName} bundle.`, dataDiff);

    try {
      // Regenerate bundle after changes
      const count = await generateAndStoreBundle(config);

      // Update metadata to track the regeneration
      await database.ref(config.metadataDocPath).update({
        lastUpdated: Date.now(),
        [`${config.bundleType}-count`]: count,
      });

      logger.info(`${config.displayName} bundle regenerated successfully`);
    } catch (error) {
      logger.error(`Error regenerating ${config.displayName} bundle after operation:`, error);
      throw handleError(error);
    }
  });
}
