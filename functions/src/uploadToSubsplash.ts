import * as functions from 'firebase-functions';
import FormData from 'form-data';
import axios, { AxiosRequestConfig } from 'axios';

const uploadToSubsplash = functions.https.onRequest(async (request, response) => {
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

export default uploadToSubsplash;
