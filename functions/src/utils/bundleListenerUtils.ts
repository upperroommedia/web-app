import { firestore, logger } from 'firebase-functions/v2';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../handleError';
import { BundleConfig } from '@upperroom/shared/shared/bundleConfigs';
import { generateAndStoreBundle } from './bundleCreationUtils';
import { randomUUID } from 'crypto';

const database = firebaseAdmin.database();
const BUNDLE_REGEN_DEBOUNCE_MS = 2_500;
const MAX_REGEN_CYCLES_PER_OWNER = 5;

type BundleRegenerationState = {
  inProgress?: boolean;
  processorToken?: string;
  latestRequestAt?: number;
};

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const getRegenerationStateRef = (metadataDocPath: string) =>
  database.ref(`${metadataDocPath}/_regeneration`);

async function claimBundleRegeneration(metadataDocPath: string): Promise<{
  isOwner: boolean;
  processorToken: string;
}> {
  const processorToken = randomUUID();
  const requestAt = Date.now();
  const stateRef = getRegenerationStateRef(metadataDocPath);

  const transactionResult = await stateRef.transaction((currentState: BundleRegenerationState | null) => {
    const nextState: BundleRegenerationState = {
      ...(currentState ?? {}),
      latestRequestAt: requestAt,
    };

    if (!currentState?.inProgress) {
      nextState.inProgress = true;
      nextState.processorToken = processorToken;
    }

    return nextState;
  });

  const finalState = transactionResult.snapshot.val() as BundleRegenerationState | null;

  return {
    isOwner: finalState?.processorToken === processorToken,
    processorToken,
  };
}

async function releaseBundleRegeneration(metadataDocPath: string, processorToken: string): Promise<void> {
  const stateRef = getRegenerationStateRef(metadataDocPath);
  await stateRef.transaction((currentState: BundleRegenerationState | null) => {
    if (!currentState || currentState.processorToken !== processorToken) {
      return currentState;
    }

    return null;
  });
}

async function shouldRunAnotherBundleCycle(
  metadataDocPath: string,
  processorToken: string,
  processedRequestAt: number
): Promise<boolean> {
  const stateRef = getRegenerationStateRef(metadataDocPath);
  const transactionResult = await stateRef.transaction((currentState: BundleRegenerationState | null) => {
    if (!currentState || currentState.processorToken !== processorToken) {
      return currentState;
    }

    if ((currentState.latestRequestAt ?? 0) > processedRequestAt) {
      return currentState;
    }

    return null;
  });

  return transactionResult.snapshot.exists();
}

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

    let ownedProcessorToken: string | null = null;
    try {
      const claim = await claimBundleRegeneration(config.metadataDocPath);
      ownedProcessorToken = claim.isOwner ? claim.processorToken : null;

      if (!claim.isOwner) {
        logger.info(
          `${config.displayName} bundle regeneration already in progress; coalescing this request into the active cycle.`
        );
        return;
      }

      let cycles = 0;
      while (cycles < MAX_REGEN_CYCLES_PER_OWNER) {
        cycles += 1;

        await delay(BUNDLE_REGEN_DEBOUNCE_MS);

        const currentState = (
          await getRegenerationStateRef(config.metadataDocPath).once('value')
        ).val() as BundleRegenerationState | null;

        if (!currentState || currentState.processorToken !== claim.processorToken) {
          logger.warn(`${config.displayName} bundle regeneration ownership was lost before generation started.`);
          return;
        }

        const processedRequestAt = currentState.latestRequestAt ?? Date.now();
        logger.info(`${config.displayName} bundle regeneration cycle starting.`, {
          cycle: cycles,
          processedRequestAt,
        });

        const count = await generateAndStoreBundle(config);

        await database.ref(config.metadataDocPath).update({
          lastUpdated: Date.now(),
          [`${config.bundleType}-count`]: count,
        });

        const shouldContinue = await shouldRunAnotherBundleCycle(
          config.metadataDocPath,
          claim.processorToken,
          processedRequestAt
        );

        if (!shouldContinue) {
          logger.info(`${config.displayName} bundle regenerated successfully`, { cycles });
          return;
        }

        logger.info(`${config.displayName} bundle received another queued mutation during regeneration; running another cycle.`, {
          cycle: cycles,
        });
      }

      logger.warn(`${config.displayName} bundle regeneration hit the cycle cap; releasing the lock for a future mutation to retry.`);
    } catch (error) {
      logger.error(`Error regenerating ${config.displayName} bundle after operation:`, error);
      throw handleError(error);
    } finally {
      if (ownedProcessorToken) {
        await releaseBundleRegeneration(config.metadataDocPath, ownedProcessorToken);
      }
    }
  });
}
