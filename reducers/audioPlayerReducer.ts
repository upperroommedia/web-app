import { Sermon } from '../types/Sermon';
export interface SermonWithMetadata extends Sermon {
  currentSecond: number;
  url?: string;
}

export type AudioPlayerState = {
  playlist: SermonWithMetadata[];
  currentSermonIndex: number;
  currentSermonSecond: number;
  playing: boolean;
};

export default function audioPlayerReducer(
  state: AudioPlayerState,
  action: { type: string; payload: any }
) {
  const { type, payload } = action;
  // console.log(type, payload);
  switch (type) {
    case 'SET_PLAYLIST': {
      return {
        ...state,
        playlist: payload,
      };
    }
    case 'SET_CURRENT_SERMON_INDEX': {
      // update playstate of previous sermon
      const updatedPlaylist = state.playlist;
      updatedPlaylist[state.currentSermonIndex] = {
        ...state.playlist[state.currentSermonIndex],
        currentSecond: state.currentSermonSecond,
      };
      return {
        ...state,
        playlist: updatedPlaylist,
        currentSermonSecond: updatedPlaylist[payload].currentSecond,
        currentSermonIndex: payload,
      };
    }

    case 'UPDATE_CURRENT_SERMON': {
      const updatedPlaylist = state.playlist;
      updatedPlaylist[state.currentSermonIndex] = payload;
      return {
        ...state,
        playlist: updatedPlaylist,
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
        currentSermonSecond: payload,
      };

    default:
      throw new Error(`No case for ${type} in auidoPlayerReducer`);
  }
}
