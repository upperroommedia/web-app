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
  switch (type) {
    case 'UPDATE_CURRENT_SERMON': {
      if (payload === undefined) {
        if (state.currentSermon === undefined && state.currentSermonSecond === 0 && state.playing === false) {
          return state;
        }
        return {
          ...state,
          currentSermon: undefined,
          currentSermonSecond: 0,
          playing: false,
        };
      }

      const nextSermon: SermonWithMetadata = {
        ...payload,
        currentSecond: 0,
      };

      if (
        state.currentSermon?.id === nextSermon.id &&
        state.currentSermon?.url === nextSermon.url &&
        state.currentSermonSecond === 0
      ) {
        return state;
      }

      return {
        ...state,
        currentSermon: nextSermon,
        currentSermonSecond: 0,
      };
    }

    case 'SET_CURRENT_SERMON_URL': {
      if (!state.currentSermon) {
        return state;
      }

      if (state.currentSermon.url === payload) {
        return state;
      }

      return {
        ...state,
        currentSermon: {
          ...state.currentSermon,
          url: payload,
        },
      };
    }

    case 'TOGGLE_PLAYING': {
      const nextPlaying = payload === undefined ? !state.playing : payload;
      if (state.playing === nextPlaying) {
        return state;
      }
      return {
        ...state,
        playing: nextPlaying,
      };
    }

    case 'UPDATE_CURRENT_SECOND':
      if (state.currentSermonSecond === payload) {
        return state;
      }
      return {
        ...state,
        currentSermon: state.currentSermon ? { ...state.currentSermon, currentSecond: payload } : undefined,
        currentSermonSecond: payload,
      };

    default:
      throw new Error(`No case for ${type} in audioPlayerReducer`);
  }
}
