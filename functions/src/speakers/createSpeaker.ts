import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { isUserRoleAdmin } from '@upperroom/shared/types/User';
import handleError from '../handleError';
import { subsplashSecretsWithRuntimeAlerts } from '../subsplashSecrets';
import { CreateSpeakerCallableInputType, CreateSpeakerCallableOutputType } from './createSpeakerTypes';
import { createSpeakerMutation, parseCreateSpeakerInput } from './speakerMutations';

const createspeaker = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<CreateSpeakerCallableInputType>): Promise<CreateSpeakerCallableOutputType> =>{
logger.log('createspeaker', {
      uid: request.auth?.uid,
      createSpeakerList: request.data?.createSpeakerList,
    });
if (!isUserRoleAdmin(request.auth?.token.role)) {
      throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
if (!request.auth?.uid) {
 const { HttpsError } = await import('firebase-functions/v2/https');
 throw new HttpsError('unauthenticated', 'Authentication is required.');
}
const { withLegacyAdmissionLease } = await import('../temporal/legacyAdmissionLease');
return withLegacyAdmissionLease(firebaseAdmin.firestore(), {domain:'publishing',actorUid:request.auth.uid,operation:"speakers/createSpeaker",projectId:firebaseAdmin.app().options.projectId || ''}, async lease => {
 await lease.markEffectsStarted();
try {
      const parsedInput = parseCreateSpeakerInput(request.data);
      return await createSpeakerMutation(parsedInput);
    } catch (error) {
      throw handleError(error);
    }
});
}
);

export default createspeaker;
