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

type AudioPlayerAction = {
  type: string;
  payload?: unknown;
};

export default function audioPlayerReducer(
  state: AudioPlayerState,
  action: AudioPlayerAction
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
      const nextSermonPayload = payload as SermonWithMetadata;

      const nextSermon: SermonWithMetadata = {
        ...nextSermonPayload,
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
      const nextUrl = payload as string | undefined;
      if (!state.currentSermon) {
        return state;
      }

      if (state.currentSermon.url === nextUrl) {
        return state;
      }

      return {
        ...state,
        currentSermon: {
          ...state.currentSermon,
          url: nextUrl,
        },
      };
    }

    case 'TOGGLE_PLAYING': {
      const nextPlayingPayload = payload as boolean | undefined;
      const nextPlaying = nextPlayingPayload === undefined ? !state.playing : nextPlayingPayload;
      if (state.playing === nextPlaying) {
        return state;
      }
      return {
        ...state,
        playing: nextPlaying,
      };
    }

    case 'UPDATE_CURRENT_SECOND': {
      const nextSecond = payload as number;
      if (state.currentSermonSecond === nextSecond) {
        return state;
      }
      return {
        ...state,
        currentSermon: state.currentSermon ? { ...state.currentSermon, currentSecond: nextSecond } : undefined,
        currentSermonSecond: nextSecond,
      };
    }

    default:
      throw new Error(`No case for ${type} in audioPlayerReducer`);
  }
}
