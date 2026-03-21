import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { authenticateSubsplash } from './subsplashUtils';
import { firestoreAdminSeriesConverter } from './firestoreDataConverter';
import handleError from './handleError';
import { loadSeriesRemoteState } from './helpers/seriesRemoteState';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import type {
  GetSeriesRemoteStateInputType,
  GetSeriesRemoteStateOutputType,
} from '../../packages/contracts/getSeriesRemoteState';

const firestoreDB = firebaseAdmin.firestore();

const getSeriesRemoteState = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<GetSeriesRemoteStateInputType>): Promise<GetSeriesRemoteStateOutputType> => {
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    const firestoreSeriesId = request.data.firestoreSeriesId?.trim();
    if (!firestoreSeriesId) {
      throw new HttpsError('invalid-argument', 'firestoreSeriesId is required.');
    }

    try {
      const seriesDoc = await firestoreDB
        .collection('series')
        .doc(firestoreSeriesId)
        .withConverter(firestoreAdminSeriesConverter)
        .get();

      if (!seriesDoc.exists) {
        throw new HttpsError('not-found', `Series with firestoreId ${firestoreSeriesId} not found.`);
      }

      const series = seriesDoc.data()!;
      const subsplashSeriesId = series.subsplashId?.trim();
      if (!subsplashSeriesId) {
        throw new HttpsError(
          'failed-precondition',
          `Series ${firestoreSeriesId} is not linked to Subsplash and has no remote state.`
        );
      }

      const token = await authenticateSubsplash();
      return loadSeriesRemoteState(firestoreSeriesId, subsplashSeriesId, token);
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default getSeriesRemoteState;
