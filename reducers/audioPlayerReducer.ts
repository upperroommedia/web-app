import {
  AudioPlayerState,
  AUDIO_PLAYER,
  PlayedState,
  PLAY_STATE,
} from '../context/types';

export default function audioPlayerReducer(
  state: AudioPlayerState,
  action: { type: string; payload: any }
): AudioPlayerState {
  const { type, payload } = action;
  // console.log(type, payload);
  switch (type) {
    case AUDIO_PLAYER.SET_PLAYLIST: {
      return {
        ...state,
        playlist: payload,
        currentSermonSecond:
          payload[state.currentSermonIndex].playedState
            .playPositionMilliseconds,
      };
    }
    case AUDIO_PLAYER.SET_CURRENT_SERMON_INDEX: {
      // update playstate of previous sermon
      console.log('SET_CURRENT_SERMON_INDEX');
      const playedState: PlayedState = {
        playPositionMilliseconds: state.currentSermonSecond,
        state: state.currentPlayedState,
      };
      const updatedPlaylist = state.playlist;
      updatedPlaylist[state.currentSermonIndex] = {
        ...state.playlist[state.currentSermonIndex],
        playedState: playedState,
      };

      console.log(updatedPlaylist[state.currentSermonIndex]);
      return {
        ...state,
        playlist: updatedPlaylist,
        currentSermonSecond:
          updatedPlaylist[payload].playedState.playPositionMilliseconds,
        currentPlayedState: state.playing
          ? PLAY_STATE.IN_PROGRESS
          : updatedPlaylist[payload].playedState.state,
        currentSermonIndex: payload,
      };
    }

    case AUDIO_PLAYER.UPDATE_CURRENT_SERMON: {
      const updatedPlaylist = state.playlist;
      updatedPlaylist[state.currentSermonIndex] = payload;
      return {
        ...state,
        playlist: updatedPlaylist,
      };
    }

    case AUDIO_PLAYER.TOGGLE_PLAYING: {
      console.log('TOGGLE_PLAYING TO: ', payload);
      if (payload) {
        return {
          ...state,
          currentPlayedState: PLAY_STATE.IN_PROGRESS,
          playing: payload,
        };
      } else {
        const updatedPlaylist = state.playlist;
        updatedPlaylist[state.currentSermonIndex].playedState = {
          playPositionMilliseconds: state.currentSermonSecond,
          state: PLAY_STATE.IN_PROGRESS,
        };
        return {
          ...state,
          playlist: updatedPlaylist,
          playing: payload,
        };
      }
    }

    case AUDIO_PLAYER.UPDATE_CURRENT_SECOND:
      return {
        ...state,
        currentSermonSecond: payload,
      };

    case AUDIO_PLAYER.SERMON_ENDED: {
      console.log('sermon ended dispatch');
      const updatedPlaylist = state.playlist;
      updatedPlaylist[state.currentSermonIndex] = {
        ...state.playlist[state.currentSermonIndex],
        playedState: {
          playPositionMilliseconds: 0,
          state: PLAY_STATE.COMPLETED,
        },
      };
      console.log(updatedPlaylist[state.currentSermonIndex]);
      return {
        ...state,
        currentPlayedState: PLAY_STATE.COMPLETED,
        currentSermonSecond: 0,
        playlist: updatedPlaylist,
      };
    }

    default:
      throw new Error(`No case for ${type} in auidoPlayerReducer`);
  }
}
