import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '../../../types/User';
import handleError from '../handleError';
import { subsplashSecrets } from '../subsplashSecrets';
import { UpdateSpeakerCallableInputType, UpdateSpeakerCallableOutputType } from './createSpeakerTypes';
import { parseUpdateSpeakerInput, updateSpeakerMutation } from './speakerMutations';

const updatespeaker = onCall(
  { secrets: subsplashSecrets },
  async (request: CallableRequest<UpdateSpeakerCallableInputType>): Promise<UpdateSpeakerCallableOutputType> => {
    logger.log('updatespeaker', {
      uid: request.auth?.uid,
      speakerId: request.data?.speakerId,
      createSpeakerList: request.data?.createSpeakerList,
      deleteAssociatedList: request.data?.deleteAssociatedList,
    });
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    try {
      const parsedInput = parseUpdateSpeakerInput(request.data);
      return await updateSpeakerMutation(parsedInput);
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default updatespeaker;
