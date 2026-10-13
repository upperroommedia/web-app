import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import handleError from '../handleError';
import { subsplashSecretsWithRuntimeAlerts } from '../subsplashSecrets';
import { UpdateSpeakerCallableInputType, UpdateSpeakerCallableOutputType } from './createSpeakerTypes';
import { parseUpdateSpeakerInput, updateSpeakerMutation } from './speakerMutations';

const updatespeaker = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<UpdateSpeakerCallableInputType>): Promise<UpdateSpeakerCallableOutputType> =>{
logger.log('updatespeaker', {
      uid: request.auth?.uid,
      speakerId: request.data?.speakerId,
      createSpeakerList: request.data?.createSpeakerList,
      deleteAssociatedList: request.data?.deleteAssociatedList,
    });
if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
if (!request.auth?.uid) {
 const { HttpsError } = await import('firebase-functions/v2/https');
 throw new HttpsError('unauthenticated', 'Authentication is required.');
}
const { withLegacyAdmissionLease } = await import('../temporal/legacyAdmissionLease');
return withLegacyAdmissionLease(firebaseAdmin.firestore(), {domain:'publishing',actorUid:request.auth.uid,operation:"speakers/updateSpeaker",projectId:firebaseAdmin.app().options.projectId || ''}, async lease => {
 await lease.markEffectsStarted();
try {
      const parsedInput = parseUpdateSpeakerInput(request.data);
      return await updateSpeakerMutation(parsedInput);
    } catch (error) {
      throw handleError(error);
    }
});
}
);

export default updatespeaker;
