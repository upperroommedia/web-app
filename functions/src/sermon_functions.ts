import * as functions from 'firebase-functions';
import { DocumentSnapshot } from 'firebase-functions/lib/providers/firestore';
import admin from 'firebase-admin';
import {
  FirebaseSermon,
  ListenTimeData,
  PlayedState,
  PLAY_STATE,
  Sermon,
} from '../../context/types';
import { getDateString } from '../../utils/sermonUtils';
import { GetSermonParams, GetSermonsResponse } from '../shared_types/sermons';
import { DocumentData } from 'firebase/firestore';

export const getSermons = functions.https.onCall(
  async (
    { userId }: GetSermonParams,
    _context
  ): Promise<GetSermonsResponse> => {
    const firestore = admin.firestore();
    const sermons = await firestore.collection('sermons').get();
    const playedStateMap = new Map<string, PlayedState>();
    if (userId) {
      const fetchPromises: Promise<DocumentSnapshot>[] = [];
      sermons.docs.forEach((sermon) => {
        const nextPromise = firestore
          .doc(`/users/${userId}/listenHistory/${sermon.id}`)
          .get();
        fetchPromises.push(nextPromise);
      });
      const snapshot = await Promise.all(fetchPromises);
      snapshot.forEach((snapshot) => {
        const data = snapshot.data() as ListenTimeData;
        if (data) {
          playedStateMap.set(snapshot.id, data.playedState);
        }
      });
    }

    const defualtPlayedState: PlayedState = {
      playPositionMilliseconds: 0,
      state: PLAY_STATE.NOT_STARTED,
    };
    return {
      sermons: sermons.docs.map((sermonDoc: DocumentData): Sermon => {
        const { date, ...data } = sermonDoc.data() as FirebaseSermon;
        const sermonData: Sermon = {
          ...data,
          dateMillis: date.toMillis(),
          dateString: getDateString(date.toDate()),
        };
        const playedStateData = playedStateMap.get(sermonDoc.id);
        return {
          ...sermonData,
          playedState: playedStateData ?? defualtPlayedState,
        };
      }),
    };
  }
);
