import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { isUserRoleAdmin } from '@upperroom/shared/types/User';
import handleError from '../handleError';
import { subsplashSecretsWithRuntimeAlerts } from '../subsplashSecrets';
import { DeleteSpeakerCallableInputType, DeleteSpeakerCallableOutputType } from './createSpeakerTypes';
import { deleteSpeakerMutation, parseDeleteSpeakerInput } from './speakerMutations';

const deletespeaker = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<DeleteSpeakerCallableInputType>): Promise<DeleteSpeakerCallableOutputType> =>{
logger.log('deletespeaker', {
      uid: request.auth?.uid,
      speakerId: request.data?.speakerId,
      deleteAssociatedList: request.data?.deleteAssociatedList,
    });
if (!isUserRoleAdmin(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
if (!request.auth?.uid) {
 const { HttpsError } = await import('firebase-functions/v2/https');
 throw new HttpsError('unauthenticated', 'Authentication is required.');
}
const { withLegacyAdmissionLease } = await import('../temporal/legacyAdmissionLease');
return withLegacyAdmissionLease(firebaseAdmin.firestore(), {domain:'publishing',actorUid:request.auth.uid,operation:"speakers/deleteSpeaker",projectId:firebaseAdmin.app().options.projectId || ''}, async lease => {
 await lease.markEffectsStarted();
try {
      const parsedInput = parseDeleteSpeakerInput(request.data);
      return await deleteSpeakerMutation(parsedInput);
    } catch (error) {
      throw handleError(error);
    }
});
}
);

export default deletespeaker;
