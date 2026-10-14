import { isDomainTemporalEnabled } from '../temporal/ownership';
import { HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { FirestoreDataConverter, Query } from 'firebase-admin/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { BundleConfig, BundleMetadata } from '@upperroom/shared/shared/bundleConfigs';
import { getFirebaseProjectId, getFirebaseStorageBucket } from '@upperroom/shared/shared/firebaseProjectConfig';
import { Writable } from 'stream';
import handleError from '../handleError';
import { withLegacyAdmissionLease } from '../temporal/legacyAdmissionLease';

const firestoreAdmin = firebaseAdmin.firestore();
const storage = firebaseAdmin.storage();
const database = firebaseAdmin.database();
const BUNDLE_BUCKET = getFirebaseStorageBucket();

type BundleErrorResponse = {
  json: (body: { error: string }) => void;
};

interface BundleHttpResponse extends Writable {
  set: (field: string, value: string) => BundleHttpResponse;
  send: (body: unknown) => void;
  status: (code: number) => BundleErrorResponse;
}

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
  whereConditions?: Array<{ field: string; operator: unknown; value: unknown }>;
}

export async function serveBundleFromStorage<T>(
  config: BundleConfig<T>,
  response: BundleHttpResponse
): Promise<boolean> {
  const bucket = storage.bucket(BUNDLE_BUCKET);
  const durablePointer = isDomainTemporalEnabled('bundles')
    ? (await firestoreAdmin.collection('_durableBundlePointers').doc(config.bundleType).get()).data()
    : undefined;
  const storagePath = typeof durablePointer?.storagePath === 'string' ? durablePointer.storagePath : config.bundlePath;
  const bundleFile = bucket.file(storagePath);
  const [exists] = await bundleFile.exists();

  if (exists) {
    logger.info(`Serving cached ${config.displayName} bundle from Cloud Storage`);

    // Get bundle metadata from storage
    const [storageMetadata] = await bundleFile.getMetadata();

    // Safely extract timestamp with type checking
    const timestampValue = storageMetadata.metadata?.timestamp;
    const bundleTimestamp = (typeof timestampValue === 'string' ? parseInt(timestampValue, 10) : null) || Date.now();

    // Public delivery is read-only. Generation owns metadata publication; a
    // cache hit must remain available even while admissions are paused.

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
  response?: BundleHttpResponse,
  options?: { publishMetadata?: boolean }
): Promise<number> {
  try {
    logger.info(`Generating new ${config.displayName} bundle`);

    // Build query
    const adminConverter = config.converter as unknown as FirestoreDataConverter<T>;
    let query: Query<T> = firestoreAdmin.collection(config.collectionName).withConverter(adminConverter);

    // Add where conditions if specified
    if (config.whereConditions) {
      config.whereConditions.forEach((condition) => {
        query = query.where(condition.field, condition.operator, condition.value);
      });
    }

    // Add ordering if specified
    if (config.orderByField) {
      query = query.orderBy(config.orderByField);
    }

    const snapshot = await query.get();
    logger.info(
      `Retrieved ${snapshot.size} ${config.displayName} sorted by ${
        config.orderByField || 'default'
      } for bundle generation`
    );

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
          generatedAt: new Date().toISOString(),
        },
      },
    });

    // Update bundle metadata in Realtime Database
    const metadataUpdate = {
      lastUpdated: bundleTimestamp,
      [`${config.bundleType}-count`]: count,
      storagePath: config.bundlePath,
    } as BundleMetadata;

    // Preserve the listener's sibling _regeneration claim until its leased
    // owner settles the cycle; replacing this node would erase that claim.
    if (options?.publishMetadata !== false) await database.ref(config.metadataDocPath).update(metadataUpdate);

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
  _request: unknown,
  response: BundleHttpResponse
): Promise<void> {
  try {
    logger.info(`Serving ${config.displayName} bundle`);

    // Try to serve from storage first
    const servedFromCache = await serveBundleFromStorage(config, response);

    if (!servedFromCache) {
      if (isDomainTemporalEnabled('bundles')) {
        await (
          await import('../temporal/bundles/admission')
        ).admitBundleRegeneration(
          config.bundleType,
          `cache-miss:${config.bundleType}:${Math.floor(Date.now() / 30_000)}`
        );
        response.set('Retry-After', '3');
        response.status(503).json({ error: 'Bundle is being prepared. Please retry shortly.' });
        return;
      }
      await withLegacyAdmissionLease(
        firestoreAdmin,
        {
          domain: 'bundles',
          actorUid: 'system:public-bundle',
          operation: `bundle.http:${config.bundleType}`,
          projectId: getFirebaseProjectId(),
        },
        async (lease) => {
          // Pause conflicts with lease admission, and the admitted invocation
          // stays visible to drain until storage and metadata publication finish.
          await lease.markEffectsStarted();
          logger.info(`No cached ${config.displayName} bundle found, generating new one`);
          await generateAndStoreBundle(config, response);
        }
      );
    }
  } catch (error) {
    if (error instanceof HttpsError && ['unavailable', 'failed-precondition'].includes(error.code)) {
      response.set('Retry-After', '3');
      response.status(503).json({ error: 'Bundle preparation is temporarily paused. Please retry shortly.' });
      return;
    }
    handleError(error, {
      alertCode: 'BUNDLE_SERVE_RUNTIME_FAILURE',
      summary: `createBundleHandler failed while serving ${config.displayName} bundle.`,
      context: {
        bundleType: config.bundleType,
        displayName: config.displayName,
        metadataPath: config.metadataDocPath,
      },
    });
    logger.error(`Error serving ${config.displayName} bundle:`, error);
    response.status(500).json({ error: `Failed to serve ${config.displayName} bundle` });
  }
}
