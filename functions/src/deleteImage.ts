import axios from 'axios';
import { https } from 'firebase-functions';
import { authenticateSubsplashV2, createAxiosConfig } from './subsplashUtils';

const setUserRole = https.onCall(async (imageId: string, context) => {
  if (context.auth?.token.role !== 'admin') {
    return { status: 'Not Authorized' };
  }
  if (!imageId) {
    return { status: 'Invalid image id' };
  }
  try {
    const bearerToken = await authenticateSubsplashV2();
    const config = createAxiosConfig(`https://core.subsplash.com/files/v1/images/${imageId}`, bearerToken, 'DELETE');
    return (await axios(config)).data;
  } catch (e) {
    if (e instanceof Error) {
      return { status: e.message };
    }
    return { status: JSON.stringify(e) };
  }
});

export default setUserRole;
