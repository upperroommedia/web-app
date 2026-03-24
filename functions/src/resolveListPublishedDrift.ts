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
  ): Promise<ResolveListPublishedDriftOutputType> => {
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
  }
);

export default resolvelistpublisheddrift;
