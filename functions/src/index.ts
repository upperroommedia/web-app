import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { GetSignedUrlConfig } from '@google-cloud/storage';
import axios, { AxiosResponse, AxiosRequestConfig } from 'axios';
import FormData from 'form-data';
admin.initializeApp();

// To test functions run: npm run-script build && firebase emulators:start --only functions

export const trimAudio = functions.storage
  .object()
  .onFinalize(async (object) => {
    const fileBucket = object.bucket;
    const fileName = object.name;
    if (fileName == undefined)
      return functions.logger.error('FileName is undefined');
    if (process.env.DOLBYIO_API_KEY == undefined)
      return functions.logger.error('DOLBYIO_API_KEY is undefined');
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
    const [inputUrl] = await admin
      .storage()
      .bucket(fileBucket)
      .file(fileName)
      .getSignedUrl(inputOptions);

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
      .file(
        `processed-sermons/${
          fileName.split('/')[1].split('.')[0]
        }.${transcodeTo}`
      )
      .getSignedUrl(outputOptions);

    const axiosResponse: AxiosResponse = await axios({
      method: 'post',
      url: 'https://api.dolby.com/media/transcode',
      headers: {
        'x-api-key': process.env.DOLBYIO_API_KEY,
        'Content-Type': 'application/json', // tried chaining this to audio/mp4
        Accept: 'application/json',
      },
      data: {
        inputs: [
          {
            source: { url: inputUrl },
            segment: { start: 0, duration: 10 },
          },
        ],
        outputs: [
          {
            audio: [{}],
            destination: outputUrl,
            kind: transcodeTo,
          },
        ],
      },
    });
    functions.logger.info(`Job ID: ${axiosResponse.data.job_id}`);
    return true;
  });

export const uploadToSubsplash = functions.https.onRequest(
  async (request, response) => {
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
        tags = tags.concat(
          request.body.speakers.map((speaker: string) => `speaker:${speaker}`)
        );
      }
      if (Array.isArray(request.body.topics)) {
        if (request.body.topics.length > 10) {
          throw new Error('Too many topics: Max 10 topics allowed');
        }
        tags = tags.concat(
          request.body.topics.map((topic: string) => `topic:${topic}`)
        );
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
        auto_publish: false, // TODO: Change to true
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
  }
);
