import { logger } from 'firebase-functions/v2';
import { FieldValue, FirestoreDataConverter, Query } from 'firebase-admin/firestore';
import firebaseAdmin from '../../../firebase/firebaseAdmin';

const firestoreAdmin = firebaseAdmin.firestore();
const storage = firebaseAdmin.storage();
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

export async function serveBundleFromStorage(
    bundlePath: string,
    displayName: string,
    response: any
): Promise<boolean> {
    const bucket = storage.bucket(BUNDLE_BUCKET);
    const bundleFile = bucket.file(bundlePath);
    const [exists] = await bundleFile.exists();

    if (exists) {
        logger.info(`Serving cached ${displayName} bundle from Cloud Storage`);

        // Get bundle metadata
        const [metadata] = await bundleFile.getMetadata();
        const bundleTimestamp = metadata.metadata?.timestamp || Date.now();

        // Set response headers
        response.set('Content-Type', 'application/octet-stream');
        response.set('Cache-Control', 'public, max-age=3600');
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
    config: BundleCreationConfig<T>,
    response?: any
): Promise<void> {
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
        const bundle = firestoreAdmin.bundle(config.bundleName);

        // Add documents to the bundle individually
        snapshot.docs.forEach(doc => {
            bundle.add(doc);
        });

        // Add the named query with the snapshot
        bundle.add(config.namedQueryName, snapshot);

        // Build the final bundle
        const bundleBuffer = bundle.build();
        const bundleTimestamp = Date.now();

        // Save bundle to Cloud Storage
        const bucket = storage.bucket(BUNDLE_BUCKET);
        const bundleFile = bucket.file(config.bundlePath);

        await bundleFile.save(bundleBuffer, {
            metadata: {
                contentType: 'application/octet-stream',
                cacheControl: 'public, max-age=3600',
                metadata: {
                    timestamp: bundleTimestamp.toString(),
                    [`${config.countFieldName}Count`]: snapshot.size.toString(),
                    generatedAt: new Date().toISOString()
                }
            }
        });

        // Update bundle metadata in Firestore
        const metadataUpdate = {
            lastUpdated: bundleTimestamp,
            [config.countFieldName + 'Count']: snapshot.size,
            storagePath: config.bundlePath,
            createdAt: FieldValue.serverTimestamp()
        };

        await firestoreAdmin.doc(config.metadataDocPath).set(metadataUpdate);

        logger.info(`New ${config.displayName} bundle generated and stored with ${snapshot.size} ${config.displayName}`);

        // If this was called from HTTP request, serve the bundle
        if (response) {
            response.set('Content-Type', 'application/octet-stream');
            response.set('Cache-Control', 'public, max-age=3600');
            response.set('X-Bundle-Timestamp', bundleTimestamp.toString());
            response.set('X-Bundle-Source', 'newly-generated');
            response.send(bundleBuffer);
        }

    } catch (error) {
        logger.error(`Error generating ${config.displayName} bundle:`, error);
        throw error;
    }
}

export async function createBundleHandler<T>(
    config: BundleCreationConfig<T>,
    request: any,
    response: any
): Promise<void> {
    try {
        logger.info(`Serving ${config.displayName} bundle`);

        // Try to serve from storage first
        const servedFromCache = await serveBundleFromStorage(
            config.bundlePath,
            config.displayName,
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