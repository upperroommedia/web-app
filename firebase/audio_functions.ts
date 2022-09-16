import { db } from './firebase';
import { doc, setDoc } from 'firebase/firestore';
import { ListenTimeData, PLAY_STATE, Sermon } from '../context/types';

import { createFunction } from '../utils/functionUtils';
import {
  GetSermonParams,
  GetSermonsResponse,
} from '../functions/shared_types/sermons';

export function updateListenTime(
  userId: string,
  sermonId: string,
  listenTime: number,
  state: PLAY_STATE = PLAY_STATE.IN_PROGRESS
) {
  const listenTimeData: ListenTimeData = {
    listenedAt: new Date(),
    playedState: {
      playPositionMilliseconds: listenTime,
      state: state,
    },
  };
  return setDoc(
    doc(db, 'users', userId, 'listenHistory', sermonId),
    listenTimeData,
    { merge: true }
  );
}

export async function getSermons(userId: string): Promise<Sermon[]> {
  const getSermons = createFunction<GetSermonParams, GetSermonsResponse>(
    'getSermons'
  );
  const result = await getSermons({ userId });
  return result.sermons;
}
