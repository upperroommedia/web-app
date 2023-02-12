import logger from 'firebase-functions/logger';
import axios, { AxiosResponse } from 'axios';
import getDolbyToken from './getDolbyToken';

const transcodeAudio = async (
  inputUrl: string,
  outputUrl: string,
  transcodeTo: string,
  start?: number,
  duration?: number
): Promise<AxiosResponse> => {
  logger.log('Transcode Audio with Parameters:', inputUrl, outputUrl, transcodeTo, start, duration);
  const inputs = { source: { url: inputUrl }, segment: {} };
  if (start !== undefined && duration !== undefined) {
    inputs['segment'] = { start, duration };
  }
  const bearerToken = (await getDolbyToken()).data.access_token;
  logger.log('Bearer Token', bearerToken);
  const axiosResponse: AxiosResponse = await axios({
    method: 'post',
    url: 'https://api.dolby.com/media/transcode',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json', // tried chaining this to audio/mp4
      Accept: 'application/json',
    },
    data: {
      inputs: [inputs],
      outputs: [
        {
          audio: [
            {
              codec: transcodeTo,
            },
          ],
          destination: outputUrl,
          kind: transcodeTo,
        },
      ],
    },
  });
  logger.info(`Axios Response: ${axiosResponse}`);
  return axiosResponse;
};

export default transcodeAudio;
