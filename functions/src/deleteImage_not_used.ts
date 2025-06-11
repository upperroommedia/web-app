import axios from 'axios';
import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';

interface DELETE_IMAGE_INPUT_TYPE {
  subsplashImageId: string;
}

const deleteImage = onCall(async (request: CallableRequest<DELETE_IMAGE_INPUT_TYPE>) => {
  if (request.auth?.token.role !== 'admin') {
    return { status: 'Not Authorized' };
  }

  const { subsplashImageId } = request.data;

  if (!subsplashImageId) {
    return { status: 'Invalid image id' };
  }
  try {
    const bearerToken = await authenticateSubsplash();
    const config = createAxiosConfig(`https://core.subsplash.com/files/v1/images/${subsplashImageId}`, bearerToken, 'DELETE');
    return (await axios(config)).data;
  } catch (e) {
    if (e instanceof Error) {
      return { status: e.message };
    }
    return { status: JSON.stringify(e) };
  }
});

export default deleteImage;
