import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '../../../types/User';
import handleError from '../handleError';
import { CreateSpeakerCallableInputType, CreateSpeakerCallableOutputType } from './createSpeakerTypes';
import { createSpeakerMutation, parseCreateSpeakerInput } from './speakerMutations';

const createspeaker = onCall(
  async (request: CallableRequest<CreateSpeakerCallableInputType>): Promise<CreateSpeakerCallableOutputType> => {
    logger.log('createspeaker', {
      uid: request.auth?.uid,
      createSpeakerList: request.data?.createSpeakerList,
    });
    if (!canUserRolePublish(request.auth?.token.role)) {
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
