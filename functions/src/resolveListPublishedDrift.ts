import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type {
  ResolveListPublishedDriftInputType,
  ResolveListPublishedDriftOutputType,
} from '../../packages/contracts/resolveListPublishedDrift';
import handleError from './handleError';
import { resolvePublishedListDrift } from './helpers/publishedListDrift';
import { listDebugError, listDebugLog } from './helpers/listDebugLogger';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { authenticateSubsplash } from './subsplashUtils';

const resolvelistpublisheddrift = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (
    request: CallableRequest<ResolveListPublishedDriftInputType>
  ): Promise<ResolveListPublishedDriftOutputType> =>{
listDebugLog('resolveListPublishedDrift.callable.start', {
      uid: request.auth?.uid,
      listId: request.data?.listId,
      strategy: request.data?.strategy,
    });
if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }
if (!request.auth?.uid) {
 const { HttpsError } = await import('firebase-functions/v2/https');
 throw new HttpsError('unauthenticated', 'Authentication is required.');
}
const { withLegacyAdmissionLease } = await import('./temporal/legacyAdmissionLease');
return withLegacyAdmissionLease(firebaseAdmin.firestore(), {domain:'publishing',actorUid:request.auth.uid,operation:"resolveListPublishedDrift",projectId:firebaseAdmin.app().options.projectId || ''}, async lease => {
 await lease.markEffectsStarted();
try {
      const token = await authenticateSubsplash();
      const output = await resolvePublishedListDrift({
        listId: request.data?.listId ?? '',
        strategy: request.data?.strategy ?? 'IGNORE',
        token,
      });
      listDebugLog('resolveListPublishedDrift.callable.success', {
        listId: request.data?.listId,
        strategy: request.data?.strategy,
        output,
      });
      return output;
    } catch (error) {
      listDebugError('resolveListPublishedDrift.callable.failed', {
        listId: request.data?.listId,
        strategy: request.data?.strategy,
        error,
      });
      throw handleError(error);
    }
});
}
);

export default resolvelistpublisheddrift;
