import { logger } from 'firebase-functions/v2';
import { FirestoreDataConverter, Query } from 'firebase-admin/firestore';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { BundleConfig, BundleMetadata } from '../../../shared/bundleConfigs';

const firestoreAdmin = firebaseAdmin.firestore();
const storage = firebaseAdmin.storage();
const database = firebaseAdmin.database();
const BUNDLE_BUCKET = 'urm-app.appspot.com';

export interface BundleCreationConfig<T> {
    collectionName: string;
    converter: FirestoreDataConverter<T>;
    bundleName: string;
    namedQueryName: string;
    bundlePath: string;
    metadataDocPath: string;
    countFieldName: string;
    displayName: string;
    orderByField?: string;
    whereConditions?: Array<{ field: string; operator: any; value: any }>;
}

export async function serveBundleFromStorage<T>(
    config: BundleConfig<T>,
    response: any
): Promise<boolean> {
    const bucket = storage.bucket(BUNDLE_BUCKET);
    const bundleFile = bucket.file(config.bundlePath);
    const [exists] = await bundleFile.exists();

    if (exists) {
        logger.info(`Serving cached ${config.displayName} bundle from Cloud Storage`);

        // Get bundle metadata from storage
        const [storageMetadata] = await bundleFile.getMetadata();
        const bundleTimestamp = parseInt(storageMetadata.metadata?.timestamp) || Date.now();
        const bundleCount = parseInt(storageMetadata.metadata?.[`${config.bundleType}-count`]) || 0;

        // Check if metadata exists in Realtime Database
        const rtdbMetadataRef = database.ref(config.metadataDocPath);
        const rtdbSnapshot = await rtdbMetadataRef.once('value');
        const rtdbMetadata = rtdbSnapshot.val();

        // If RTDB metadata doesn't exist but bundle exists, save metadata to RTDB
        if (!rtdbMetadata) {
            logger.info(`Bundle exists but metadata missing in Realtime Database, saving metadata for ${config.displayName}`);

            const metadataUpdate = {
                lastUpdated: bundleTimestamp,
                [`${config.bundleType}-count`]: bundleCount,
                storagePath: config.bundlePath,
            } as BundleMetadata;

            await rtdbMetadataRef.set(metadataUpdate);
            logger.info(`Metadata saved to Realtime Database for ${config.displayName} bundle`);
        }

        // Set response headers
        response.set('Content-Type', 'application/octet-stream');
        response.set('X-Bundle-Timestamp', bundleTimestamp.toString());
        response.set('X-Bundle-Source', 'storage-cache');

        // Stream the bundle from storage
        const stream = bundleFile.createReadStream();
        stream.pipe(response);
        return true;
    }

    return false;
}

export async function generateAndStoreBundle<T>(
    config: BundleConfig<T>,
    response?: any
): Promise<number> {
    try {
        logger.info(`Generating new ${config.displayName} bundle`);

        // Build query
        let query: Query<T> = firestoreAdmin
            .collection(config.collectionName)
            .withConverter(config.converter);

        // Add where conditions if specified
        if (config.whereConditions) {
            config.whereConditions.forEach(condition => {
                query = query.where(condition.field, condition.operator, condition.value);
            });
        }

        // Add ordering if specified
        if (config.orderByField) {
            query = query.orderBy(config.orderByField);
        }

        const snapshot = await query.get();
        logger.info(`Retrieved ${snapshot.size} ${config.displayName} sorted by ${config.orderByField || 'default'} for bundle generation`);

        // Create bundle
        const bundle = firestoreAdmin.bundle(`${config.bundleType}-bundle`);

        // Add the named query with the snapshot (this automatically includes all documents)
        bundle.add(config.namedQuery, snapshot);

        // Build the final bundle
        const bundleBuffer = bundle.build();
        const bundleTimestamp = Date.now();

        // Save bundle to Cloud Storage
        const bucket = storage.bucket(BUNDLE_BUCKET);
        const bundleFile = bucket.file(config.bundlePath);
        const count = snapshot.size;
        await bundleFile.save(bundleBuffer, {
            metadata: {
                contentType: 'application/octet-stream',
                metadata: {
                    timestamp: bundleTimestamp.toString(),
                    [`${config.bundleType}-count`]: count.toString(),
                    generatedAt: new Date().toISOString()
                }
            }
        });

        // Update bundle metadata in Realtime Database
        const metadataUpdate = {
            lastUpdated: bundleTimestamp,
            [`${config.bundleType}-count`]: count,
            storagePath: config.bundlePath,
        } as BundleMetadata;

        await database.ref(config.metadataDocPath).set(metadataUpdate);

        logger.info(`New ${config.displayName} bundle generated and stored with ${snapshot.size} ${config.displayName}`);

        // If this was called from HTTP request, serve the bundle
        if (response) {
            response.set('Content-Type', 'application/octet-stream');
            response.set('X-Bundle-Timestamp', bundleTimestamp.toString());
            response.set('X-Bundle-Source', 'newly-generated');
            response.send(bundleBuffer);
        }

        return count;

    } catch (error) {
        logger.error(`Error generating ${config.displayName} bundle:`, error);
        throw error;
    }
}

export async function createBundleHandler<T>(
    config: BundleConfig<T>,
    request: any,
    response: any
): Promise<void> {
    try {
        logger.info(`Serving ${config.displayName} bundle`);

        // Try to serve from storage first
        const servedFromCache = await serveBundleFromStorage(
            config,
            response
        );

        if (!servedFromCache) {
            // Generate new bundle if none exists
            logger.info(`No cached ${config.displayName} bundle found, generating new one`);
            await generateAndStoreBundle(config, response);
        }

    } catch (error) {
        logger.error(`Error serving ${config.displayName} bundle:`, error);
        response.status(500).json({ error: `Failed to serve ${config.displayName} bundle` });
    }
} 