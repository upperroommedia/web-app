import { firestore, logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import handleError from '../handleError';

const firestoreAdmin = firebaseAdmin.firestore();

export interface BundleListenerConfig {
    collectionPath: string;
    bundleRegenerationFunction: () => Promise<void>;
    displayName: string;
    metadataDocPath: string;
    shouldTrigger: (beforeData: any, afterData: any) => boolean;
}

export function createBundleDocumentListener(config: BundleListenerConfig) {
    return firestore.onDocumentWritten(
        config.collectionPath,
        async (event) => {
            const documentId = Object.values(event.params)[0] as string; // Get the first parameter (document ID)

            // Get the data from before and after
            const beforeData = event.data?.before?.data();
            const afterData = event.data?.after?.data();

            // Determine the operation type
            let operation: string;
            let reason: string;

            if (!beforeData && afterData) {
                operation = 'created';
                reason = `New ${config.displayName} created: ${documentId}`;
            } else if (beforeData && afterData) {
                operation = 'updated';
                reason = `${config.displayName} updated: ${documentId}`;
            } else if (beforeData && !afterData) {
                operation = 'deleted';
                reason = `${config.displayName} deleted: ${documentId}`;
            } else {
                logger.warn(`Unexpected document state in ${config.displayName} listener`);
                return;
            }

            // Check if we should trigger bundle regeneration
            if (!config.shouldTrigger(beforeData, afterData)) {
                return;
            }

            logger.info(`${config.displayName} ${operation}: ${documentId}. Regenerating ${config.displayName} bundle.`);

            try {
                // Regenerate bundle after changes
                await config.bundleRegenerationFunction();

                // Update metadata to track the regeneration
                await firestoreAdmin.doc(config.metadataDocPath).update({
                    lastRegeneratedReason: reason,
                    lastRegeneratedAt: FieldValue.serverTimestamp(),
                    lastOperation: operation
                });

                logger.info(`${config.displayName} bundle regenerated successfully after ${operation}`);

            } catch (error) {
                logger.error(`Error regenerating ${config.displayName} bundle after operation:`, error);
                throw handleError(error);
            }
        }
    );
} 