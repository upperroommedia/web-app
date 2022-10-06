import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { GetSignedUrlConfig } from '@google-cloud/storage';
import axios, { AxiosResponse, AxiosRequestConfig } from 'axios';
import qs from 'qs';
import FormData from 'form-data';
admin.initializeApp();

// To test functions: npm run-script serve
// To deploy functions: npm run-script deploy
const getDolbyToken = async (): Promise<AxiosResponse> => {
  const data = qs.stringify({
    grant_type: 'client_credentials',
  });

  const keySecret = `${process.env.DOLBY_API_KEY}:${process.env.DOLBY_API_SECRET}`;
  functions.logger.log('Key:Secret', keySecret);
  const creds = Buffer.from(keySecret).toString('base64');

  const config: AxiosRequestConfig = {
    method: 'post',
    url: 'https://api.dolby.io/v1/auth/token',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${creds}`,
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    data: data,
  };
  functions.logger.log('getDolbyToken axios config', config);

  return await axios(config);
};

const getOutputUrl = async (fileBucket: string, fileName: string, transcodeTo: string): Promise<string> => {
  functions.logger.log('Get Output Url with Parameters:', fileBucket, fileName, transcodeTo);
  // These options will allow temporary uploading of the file with outgoing
  // Content-types tried:
  // application/octet-stream
  // audio/mpeg
  // audio/mp4
  // application/mp4
  // and leaving it empty
  const outputOptions: GetSignedUrlConfig = {
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    // contentType: tried all of the above
  };
  const [outputUrl] = await admin
    .storage()
    .bucket(fileBucket)
    .file(`processed-sermons/${fileName}.${transcodeTo}`)
    .getSignedUrl(outputOptions);
  functions.logger.log('OutputUrl:', outputUrl);
  return outputUrl;
};

const transcodeAudio = async (
  inputUrl: string,
  outputUrl: string,
  transcodeTo: string,
  start?: number,
  duration?: number
): Promise<AxiosResponse> => {
  functions.logger.log('Transcode Audio with Parameters:', inputUrl, outputUrl, transcodeTo, start, duration);
  const inputs = { source: { url: inputUrl }, segment: {} };
  if (start !== undefined && duration !== undefined) {
    inputs['segment'] = { start, duration };
  }
  const bearerToken = (await getDolbyToken()).data.access_token;
  functions.logger.log('Bearer Token', bearerToken);
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
  functions.logger.info(`Axios Response: ${axiosResponse}`);
  return axiosResponse;
};

export const trimAudioOnStorage = functions.storage.object().onFinalize(async (object) => {
  const fileBucket = object.bucket;
  const fileName = object.name;
  if (fileName == undefined) return functions.logger.error('FileName is undefined');
  if (process.env.DOLBYIO_API_KEY == undefined) return functions.logger.error('DOLBYIO_API_KEY is undefined');
  if (!fileName.startsWith('sermons/')) {
    return functions.logger.error('Object is not a sermon');
  }
  const transcodeTo = 'mp4';
  // These options will allow temporary read access to the file
  const inputOptions: GetSignedUrlConfig = {
    version: 'v4',
    action: 'read',
    expires: Date.now() + 15 * 60 * 1000, // 15 minutes
  };
  const [inputUrl] = await admin.storage().bucket(fileBucket).file(fileName).getSignedUrl(inputOptions);

  const outputUrl = await getOutputUrl(fileBucket, fileName.split('/')[1].split('.')[0], transcodeTo);
  transcodeAudio(inputUrl, outputUrl, transcodeTo);
});

export const trimAudio = functions.https.onRequest(async (_request, response) => {
  functions.logger.info('Trying to trim audio');

  try {
    // TODO (1): replace hardcoded elements with request inputs and add checks
    const outputUrl = await getOutputUrl('sermons', 'test_youtube', 'mp3');
    const transcodeResponse = await transcodeAudio(
      'https://www.youtube.com/watch?v=utHMClq8tYo',
      outputUrl,
      'mp3',
      45,
      30
    );
    functions.logger.info(`Trim Audio: ${transcodeResponse.data}`);
    response.send(transcodeResponse.data);
  } catch (error) {
    functions.logger.log(error);
    response.send(error);
  }
  functions.logger.info('DONE WITH TRIM AUDIO FUNCITON');
});

export const uploadToSubsplash = functions.https.onRequest(async (request, response) => {
  console.log('Request: ' + JSON.stringify(request.body, null, 2));
  if (process.env.EMAIL == undefined || process.env.PASSWORD == undefined) {
    response.send('Email or Password are not set in .env file');
    return;
  }
  try {
    const formData = new FormData();
    formData.append('grant_type', 'password');
    formData.append('scope', 'app:9XTSHD');
    formData.append('email', process.env.EMAIL);
    formData.append('password', process.env.PASSWORD);

    let config: AxiosRequestConfig = {
      method: 'post',
      url: 'https://core.subsplash.com/accounts/v1/oauth/token',
      headers: {
        ...formData.getHeaders(),
      },
      data: formData,
    };
    const bearerToken = (await axios(config)).data.access_token;
    // create media item with title
    let tags: string[] = [];
    if (Array.isArray(request.body.speakers)) {
      if (request.body.speakers.length > 3) {
        throw new Error('Too many speakers: Max 3 speakers allowed');
      }
      tags = tags.concat(request.body.speakers.map((speaker: string) => `speaker:${speaker}`));
    }
    if (Array.isArray(request.body.topics)) {
      if (request.body.topics.length > 10) {
        throw new Error('Too many topics: Max 10 topics allowed');
      }
      tags = tags.concat(request.body.topics.map((topic: string) => `topic:${topic}`));
    }
    console.log('Tags: ' + tags);
    const data = JSON.stringify({
      app_key: '9XTSHD',
      scriptures: [],
      tags: tags,
      title: request.body.title,
      subtitle: request.body.subtitle,
      summary: request.body.description,
      external_audio_url: request.body.audio_url,
      date: new Date(),
      auto_publish: request.body.autoPublish ?? false, // TODO: Change to true
      _embedded: {
        images: [
          { id: '30b301b5-16f2-4982-b248-6a96a2093a1f', type: 'square' },
          { id: '3597957d-26e5-4c95-a21f-30d61d0274c5', type: 'wide' },
          { id: '090bf8b2-3bb7-4826-b4bc-b278b2927228', type: 'banner' },
        ],
      },
    });
    console.log('Request: ' + data);
    config = {
      method: 'post',
      url: 'https://core.subsplash.com/media/v1/media-items',
      headers: {
        'Cache-Control': 'no-cache',
        Authority: 'core.subsplash.com',
        Origin: 'https://dashboard.subsplash.com',
        Referer: 'https://dashboard.subsplash.com/',
        'Content-Type': 'application/vnd.api+json',
        Authorization: `Bearer ${bearerToken}`,
      },
      data: data,
    };

    response.send((await axios(config)).data);
  } catch (error) {
    functions.logger.error(error);
    let message = 'Unknown Error';
    if (error instanceof Error) message = error.message;

    response.send(message);
  }
});

export const setUserRole = functions.https.onRequest(async (request, response) => {
  if (request.body.uid && request.body.role) {
    admin
      .auth()
      .setCustomUserClaims(request.body.uid, request.body.role)
      .then((message) => response.send(message))
      .catch((e) => response.send(e));
  } else {
    response.send('uid or role do not exist');
  }
});
