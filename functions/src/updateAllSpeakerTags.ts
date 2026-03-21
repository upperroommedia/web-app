import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type { ISpeaker } from '@upperroom/shared/types/Speaker';
import type {
  UpdateAllSpeakerTagsInputType,
  UpdateAllSpeakerTagsOutputType,
  UpdateAllSpeakerTagsResultType,
} from '../../packages/contracts/updateAllSpeakerTags';
import { firestoreAdminSpeakerConverter } from './firestoreDataConverter';
import handleError from './handleError';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { createSubsplashSpeakerTag, requireSquareImage, requireTrimmedSpeakerName } from './speakers/speakerMutations';

const SCRIPT_RUNNER_EMAIL = 'youssef.a.asaad@gmail.com';
const BETWEEN_SPEAKER_DELAY_MS = 150;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

const getRetryAfterMs = (error: unknown): number | undefined => {
  if (!(error instanceof HttpsError) || !error.details || typeof error.details !== 'object') {
    return undefined;
  }

  const retryAfterMs = (error.details as { retry_after_ms?: unknown }).retry_after_ms;
  return typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined;
};

const createEmptyResult = (totalSpeakers: number): UpdateAllSpeakerTagsResultType => ({
  totalSpeakers,
  updatedCount: 0,
  skippedNoTagCount: 0,
  skippedNoSquareImageCount: 0,
  skippedNoNameCount: 0,
  failedCount: 0,
  processedSpeakerIds: [],
  failedSpeakers: [],
  abortedDueToRateLimit: false,
});

const updateAllSpeakerTags = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<UpdateAllSpeakerTagsInputType>): Promise<UpdateAllSpeakerTagsOutputType> => {
    const requester = await assertAuthorizedScriptRunner(request);

    try {
      const requesterEmail = requester.email;
      const dryRun = request.data?.dryRun === true;
      const speakersSnapshot = await firebaseAdmin
        .firestore()
        .collection('speakers')
        .withConverter(firestoreAdminSpeakerConverter)
        .get();

      const speakers = speakersSnapshot.docs
        .map((doc) => doc.data())
        .filter((speaker): speaker is ISpeaker => Boolean(speaker))
        .sort((first, second) => first.name.localeCompare(second.name));

      const result = createEmptyResult(speakers.length);

      logger.log('updateallspeakertags:start', {
        uid: requester.uid,
        requesterEmail,
        dryRun,
        totalSpeakers: speakers.length,
      });

      for (const speaker of speakers) {
        if (!speaker.tagId) {
          result.skippedNoTagCount += 1;
          continue;
        }

        let normalizedName: string;
        try {
          normalizedName = requireTrimmedSpeakerName(speaker.name, 'speaker.name');
        } catch {
          result.skippedNoNameCount += 1;
          continue;
        }

        let squareImage;
        try {
          squareImage = requireSquareImage(speaker.images, 'speaker.images');
        } catch {
          result.skippedNoSquareImageCount += 1;
          continue;
        }

        if (dryRun) {
          result.updatedCount += 1;
          result.processedSpeakerIds.push(speaker.id);
          continue;
        }

        try {
          await createSubsplashSpeakerTag({
            tagId: speaker.tagId,
            title: normalizedName,
            squareImage,
            shortDescription: speaker.shortDescription || undefined,
            description: speaker.description || undefined,
            operationKey: `admin-script-update-speaker-tag-${speaker.id}`,
          });
          result.updatedCount += 1;
          result.processedSpeakerIds.push(speaker.id);
        } catch (error) {
          const normalizedError = handleError(error, {
            alertCode: 'UPDATE_ALL_SPEAKER_TAGS_FAILURE',
            summary: 'Update-all-speaker-tags script failed while syncing a Subsplash speaker tag.',
            request,
            context: {
              functionName: 'updateAllSpeakerTags',
              speakerId: speaker.id,
              speakerName: normalizedName,
              speakerTagId: speaker.tagId,
            },
          });

          if (normalizedError.code === 'resource-exhausted') {
            result.abortedDueToRateLimit = true;
            result.retryAfterMs = getRetryAfterMs(normalizedError);
            result.failedCount += 1;
            result.failedSpeakers.push({
              speakerId: speaker.id,
              name: normalizedName,
              error: normalizedError.message,
            });
            break;
          }

          result.failedCount += 1;
          result.failedSpeakers.push({
            speakerId: speaker.id,
            name: normalizedName,
            error: normalizedError.message,
          });
        }

        await sleep(BETWEEN_SPEAKER_DELAY_MS);
      }

      logger.log('updateallspeakertags:complete', {
        uid: requester.uid,
        requesterEmail,
        dryRun,
        ...result,
      });

      return {
        status: 'success',
        data: result,
      };
    } catch (error) {
      throw handleError(error, {
        alertCode: 'UPDATE_ALL_SPEAKER_TAGS_RUNTIME_FAILURE',
        summary: 'Update-all-speaker-tags script failed before it could complete.',
        request,
        context: { functionName: 'updateAllSpeakerTags' },
      });
    }
  }
);

export default updateAllSpeakerTags;
