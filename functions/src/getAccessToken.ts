import { https } from 'firebase-functions/v2';
import { CallableRequest } from 'firebase-functions/v2/https';
import { FunctionOutputType } from '../../types/Function';
import { authenticateSubsplashV2 } from './subsplashUtils';

type GetAccessTokenOutputType = FunctionOutputType<string>;

const getAccessToken = https.onCall(async (request: CallableRequest): Promise<GetAccessTokenOutputType> => {
  // check if user is admin (true "admin" custom claim), return error if not
  if (request.auth?.token.role !== 'admin') {
    return { status: 'error', error: `Unauthorized.` };
  }
  try {
    console.log(request.auth.token);
    const accessToken = await authenticateSubsplashV2(request.auth.token.uid);
    return { status: 'success', data: accessToken };
  } catch (error) {
    return { status: 'error', error: `${error}` };
  }
});

export default getAccessToken;
