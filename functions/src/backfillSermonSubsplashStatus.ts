import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type {
  BackfillSermonSubsplashStatusInputType,
  BackfillSermonSubsplashStatusOutputType,
  BackfillSermonSubsplashStatusResultType,
} from '../../packages/contracts/backfillSermonSubsplashStatus';
import { firestoreAdminSermonConverter } from './firestoreDataConverter';
import handleError from './handleError';
import { deriveSubsplashStatus } from './utils/deriveSubsplashStatus';

const SCRIPT_RUNNER_EMAIL = 'youssef.a.asaad@gmail.com';
const MAX_PROCESSED_IDS = 200;

const getRequesterEmail = (request: CallableRequest<unknown>): string | undefined => {
  const email = request.auth?.token.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : undefined;
};

const assertAuthorizedScriptRunner = async (
  request: CallableRequest<unknown>
): Promise<{ uid: string; email: string }> => {
  const uid = request.auth?.uid;
  const tokenEmail = getRequesterEmail(request);
  if (!uid || tokenEmail !== SCRIPT_RUNNER_EMAIL) {
    throw new HttpsError('permission-denied', 'Only the designated script runner can execute this action.');
  }

  const userRecord = await firebaseAdmin.auth().getUser(uid);
  const canonicalEmail = userRecord.email?.trim().toLowerCase();
  if (canonicalEmail !== SCRIPT_RUNNER_EMAIL || userRecord.emailVerified !== true) {
    throw new HttpsError('permission-denied', 'Only the designated verified script runner can execute this action.');
  }

  return {
    uid,
    email: canonicalEmail,
  };
};

const createEmptyResult = (): BackfillSermonSubsplashStatusResultType => ({
  totalSermons: 0,
  updatedCount: 0,
  alreadyCorrectCount: 0,
  processedSermonIds: [],
});

const backfillSermonSubsplashStatus = onCall(
  {
    timeoutSeconds: 540,
    memory: '512MiB',
    maxInstances: 1,
  },
  async (
    request: CallableRequest<BackfillSermonSubsplashStatusInputType>
  ): Promise<BackfillSermonSubsplashStatusOutputType> => {
    const requester = await assertAuthorizedScriptRunner(request);

    try {
      const dryRun = request.data?.dryRun === true;
      const firestore = firebaseAdmin.firestore();
      const sermonsSnapshot = await firestore
        .collection('sermons')
        .withConverter(firestoreAdminSermonConverter)
        .get();

      const result = createEmptyResult();
      result.totalSermons = sermonsSnapshot.size;

      logger.log('backfillsermonsubsplashstatus:start', {
        uid: requester.uid,
        requesterEmail: requester.email,
        dryRun,
        totalSermons: sermonsSnapshot.size,
      });

      let batch = firestore.batch();
      let batchWrites = 0;

      for (const sermonDoc of sermonsSnapshot.docs) {
        const sermon = sermonDoc.data();
        const currentStatus = sermon.status?.subsplash ?? uploadStatus.NOT_UPLOADED;
        const nextStatus = deriveSubsplashStatus(sermon.numberOfLists, sermon.numberOfListsUploadedTo);

        if (currentStatus === nextStatus) {
          result.alreadyCorrectCount += 1;
          continue;
        }

        result.updatedCount += 1;
        if (result.processedSermonIds.length < MAX_PROCESSED_IDS) {
          result.processedSermonIds.push(sermonDoc.id);
        }

        if (dryRun) {
          continue;
        }

        batch.update(sermonDoc.ref, {
          'status.subsplash': nextStatus,
        });
        batchWrites += 1;

        if (batchWrites === 400) {
          await batch.commit();
          batch = firestore.batch();
          batchWrites = 0;
        }
      }

      if (!dryRun && batchWrites > 0) {
        await batch.commit();
      }

      logger.log('backfillsermonsubsplashstatus:complete', {
        uid: requester.uid,
        requesterEmail: requester.email,
        dryRun,
        ...result,
      });

      return {
        status: 'success',
        data: result,
      };
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default backfillSermonSubsplashStatus;
