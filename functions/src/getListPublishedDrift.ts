import { canUserRolePublish } from '@upperroom/shared/types/User';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type {
  GetListPublishedDriftInputType,
  GetListPublishedDriftOutputType,
} from '../../packages/contracts/getListPublishedDrift';
import handleError from './handleError';
import { auditPublishedListDrift } from './helpers/publishedListDrift';
import { listDebugError, listDebugLog, summarizeOverflowIssues } from './helpers/listDebugLogger';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { authenticateSubsplash } from './subsplashUtils';

const toPublishedDriftOutput = (
  output: Awaited<ReturnType<typeof auditPublishedListDrift>>
): GetListPublishedDriftOutputType => ({
  requestedListId: output.requestedListId,
  rootListId: output.rootListId,
  inSync: output.inSync,
  canReorder: output.canReorder,
  canOverflowPublish: output.canOverflowPublish,
  canDelete: output.canDelete,
  canRemove: output.canRemove,
  issues: output.issues,
  localPublishedItems: output.localPublishedItems,
  remotePublishedItems: output.remotePublishedItems,
});

const getlistpublisheddrift = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<GetListPublishedDriftInputType>): Promise<GetListPublishedDriftOutputType> => {
    listDebugLog('getListPublishedDrift.callable.start', {
      uid: request.auth?.uid,
      listId: request.data?.listId,
    });

    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    try {
      const token = await authenticateSubsplash();
      const output = await auditPublishedListDrift(request.data?.listId ?? '', token);
      const publicOutput = toPublishedDriftOutput(output);
      listDebugLog('getListPublishedDrift.callable.success', {
        listId: request.data?.listId,
        inSync: publicOutput.inSync,
        issues: summarizeOverflowIssues(publicOutput.issues),
      });
      return publicOutput;
    } catch (error) {
      listDebugError('getListPublishedDrift.callable.failed', {
        listId: request.data?.listId,
        error,
      });
      throw handleError(error);
    }
  }
);

export default getlistpublisheddrift;
