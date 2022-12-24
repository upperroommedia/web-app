// add sermon to series and handle condition when list is full
import axios from 'axios';
import { logger } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import handleError from './handleError';
import { authenticateSubsplash, createAxiosConfig } from './subsplashUtils';

export interface AddToSeriesInputType {
  listId: string;
  mediaItemIds: string[];
}

const addToSeries = onCall(async (request: CallableRequest<AddToSeriesInputType>): Promise<void> => {
  logger.log('addToSeries', request);
  if (request.auth?.token.role !== 'admin') {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }
  const data = request.data;
  logger.log('series', data.listId);
  //get current list info
  try {
    const token = await authenticateSubsplash();
    const currentListConfig = createAxiosConfig(
      `https://core.subsplash.com/builder/v1/lists/${data.listId}`,
      token,
      'GET'
    );
    const response = (await axios(currentListConfig)).data;
    const currentListCount = response.list_rows_count;
    const newListCount = currentListCount + data.mediaItemIds.length;
    if (newListCount > 200) {
      //TODO[2]: Handle condition when list is full
      throw new HttpsError('failed-precondition', 'List is full');
    }
    // Add sermons to list
    const listRows = data.mediaItemIds.map((id, index) => {
      return {
        app_key: '9XTSHD',
        method: 'static',
        position: index + 1,
        type: 'media-item',
        _embedded: {
          'media-item': {
            id: id,
          },
          'source-list': {
            id: data.listId,
          },
        },
      };
    });

    const payload = {
      id: data.listId,
      list_rows_count: newListCount,
      _embedded: {
        'list-rows': listRows,
      },
    };
    logger.log('Payload', payload);
    const patchListConfig = createAxiosConfig(
      `https://core.subsplash.com/builder/v1/lists/${data.listId}`,
      token,
      'PATCH',
      payload
    );
    logger.log('Patch List Response', (await axios(patchListConfig)).status);
    // Handle adding a Media Series
    // Handle adding another list
  } catch (error) {
    handleError(error);
  }
});

export default addToSeries;
