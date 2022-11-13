import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';
import axios from 'axios';
export interface populateSpeakerImagesInputType {
  speakerTagIds?: string[];
}

export interface populateSpeakerImagesOutputType {
  buffer: {
    type: 'Buffer';
    data: number[];
  };
}

const populateSpeakerImages = onCall(
  async (request: CallableRequest<populateSpeakerImagesInputType>): Promise<void> => {
    if (request.auth?.token.role !== 'admin') {
      throw new HttpsError('failed-precondition', 'The function must be called while authenticated.');
    }
    try {
      logger.log('hi');
      // let page_number = 1;
      const page_size = 100;
      // let loop = True;
      // let current = 0;
      const bearerToken = await authenticateSubsplash();
      // while (loop) {
      //   const axiosConfig = createAxiosConfig(
      //     `https://core.subsplash.com/tags/v1/tags?filter%5Bapp_key%5D=9XTSHD&filter%5Btype%5D=speaker&include=image&page%5Bnumber%5D=${page_number}&page%5Bsize%5D=${page_size}&sort=title`,
      //     bearerToken,
      //     'GET'
      //   );
      //   const response = await axios(axiosConfig);
      // current += response.count;
      // }
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        throw new HttpsError('internal', error.message, error.toJSON());
      }
      if (error instanceof Error) {
        throw new HttpsError('internal', error.message);
      }
      throw new HttpsError('internal', 'Unknown error');
    }
  }
);

export default populateSpeakerImages;
