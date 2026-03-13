import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { isUserRoleAdmin } from '../../../types/User';
import handleError from '../handleError';
import { subsplashSecretsWithRuntimeAlerts } from '../subsplashSecrets';
import { CreateSpeakerCallableInputType, CreateSpeakerCallableOutputType } from './createSpeakerTypes';
import { createSpeakerMutation, parseCreateSpeakerInput } from './speakerMutations';

const createspeaker = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<CreateSpeakerCallableInputType>): Promise<CreateSpeakerCallableOutputType> => {
    logger.log('createspeaker', {
      uid: request.auth?.uid,
      createSpeakerList: request.data?.createSpeakerList,
    });
    if (!isUserRoleAdmin(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    try {
      const parsedInput = parseCreateSpeakerInput(request.data);
      return await createSpeakerMutation(parsedInput);
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default createspeaker;
