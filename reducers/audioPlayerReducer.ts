import { Sermon } from '../types/SermonTypes';
export interface SermonWithMetadata extends Sermon {
  currentSecond: number;
  url?: string;
  subsplashId?: string;
}

export type AudioPlayerState = {
  currentSermon: SermonWithMetadata | undefined;
  currentSermonSecond: number;
  playing: boolean;
};

export default function audioPlayerReducer(
  state: AudioPlayerState,
  action: { type: string; payload: any }
): AudioPlayerState {
  const { type, payload } = action;
  // console.log(type, payload);
  switch (type) {
    case 'UPDATE_CURRENT_SERMON': {
      return {
        ...state,
        currentSermon: payload,
        currentSermonSecond: 0,
      };
    }

    case 'TOGGLE_PLAYING':
      return {
        ...state,
        playing: payload,
      };

    case 'UPDATE_CURRENT_SECOND':
      return {
        ...state,
        currentSermon: state.currentSermon ? { ...state.currentSermon, currentSecond: payload } : undefined,
        currentSermonSecond: payload,
      };

    default:
      throw new Error(`No case for ${type} in auidoPlayerReducer`);
  }
}
