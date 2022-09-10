import { resolve } from 'path';
import { createContext, useReducer, useContext } from 'react';
import {
  Sermon,
  AudioPlayerState,
  SermonWithMetadata,
  AUDIO_PLAYER,
  PLAY_STATE,
} from '../../context/types';

import { updateListenTime } from '../../firebase/audio_functions';
import audioPlayerReducer from '../../reducers/audioPlayerReducer';
import UserContext from '../user/UserContext';
const initialState: AudioPlayerState = {
  playlist: [],
  currentSermonIndex: 0,
  currentSermonSecond: 0,
  currentPlayedState: PLAY_STATE.NOT_STARTED,
  playing: false,
};

type AudioPlayerContextType = {
  playlist: SermonWithMetadata[];
  currentSermon: SermonWithMetadata;
  currentSecond: number;
  currentPlayedState: PLAY_STATE;
  playing: boolean;
  setPlaylist: (playlist: Sermon[]) => void;
  // addToPlaylist: (sermon: Sermon) => void;
  // removeFromPlaylist: (sermon: Sermon) => void;
  setCurrentSermonUrl: (url: string) => void;
  setCurrentSermon: (sermon: Sermon) => void;
  updateCurrentSecond: (second: number) => void;
  sermonEnded: () => void;
  togglePlaying: (play?: boolean) => void;
  nextSermon: () => void;
  previousSermon: () => void;
};

const AudioPlayerContext = createContext<AudioPlayerContextType | null>(null);

export const AudioPlayerProvider = ({ children }: any) => {
  const [state, dispatch] = useReducer(audioPlayerReducer, initialState);
  const { user } = useContext(UserContext);
  const setPlaylist = (playlist: Sermon[]) => {
    dispatch({
      type: AUDIO_PLAYER.SET_PLAYLIST,
      payload: playlist,
    });
  };

  const updateCurrentSecond = (currentSecond: number) => {
    if (currentSecond % 5 === 0) {
      updateListenTime(
        user.uid,
        state.playlist[state.currentSermonIndex].key,
        currentSecond
      );
    }
    dispatch({
      type: AUDIO_PLAYER.UPDATE_CURRENT_SECOND,
      payload: currentSecond,
    });
  };

  const togglePlaying = (play?: boolean) => {
    updateListenTime(
      user.uid,
      state.playlist[state.currentSermonIndex].key,
      state.currentSermonSecond
    );
    if (play === undefined) {
      play = !state.playing;
    }
    dispatch({ type: AUDIO_PLAYER.TOGGLE_PLAYING, payload: play });
  };

  const setCurrentSermon = (sermon: Sermon) => {
    if (state.playlist[state.currentSermonIndex].key === sermon.key) return;
    const currentSermonIndex = state.playlist.findIndex(
      (s: SermonWithMetadata) => s.key === sermon.key
    );
    dispatch({
      type: AUDIO_PLAYER.SET_CURRENT_SERMON_INDEX,
      payload: currentSermonIndex,
    });
  };
  const nextSermon = () => {
    dispatch({
      type: AUDIO_PLAYER.SET_CURRENT_SERMON_INDEX,
      payload: (state.currentSermonIndex + 1) % state.playlist.length,
    });
  };

  const previousSermon = () => {
    dispatch({
      type: AUDIO_PLAYER.SET_CURRENT_SERMON_INDEX,
      payload: (state.currentSermonIndex - 1) % state.playlist.length,
    });
  };

  const setCurrentSermonUrl = (url: string) => {
    const sermon: SermonWithMetadata = {
      ...state.playlist[state.currentSermonIndex],
      url,
    };
    dispatch({ type: AUDIO_PLAYER.UPDATE_CURRENT_SERMON, payload: sermon });
  };

  const sermonEnded = () => {
    console.log('sermon ended');
    updateListenTime(
      user.uid,
      state.playlist[state.currentSermonIndex].key,
      0,
      PLAY_STATE.COMPLETED
    );
    dispatch({ type: AUDIO_PLAYER.SERMON_ENDED, payload: null });
    resolve();
    nextSermon();
  };

  return (
    <AudioPlayerContext.Provider
      value={{
        playlist: state.playlist,
        currentSermon: state.playlist[state.currentSermonIndex],
        currentSecond: state.currentSermonSecond,
        currentPlayedState: state.currentPlayedState,
        playing: state.playing,
        setPlaylist,
        // addToPlaylist,
        // removeFromPlaylist,
        setCurrentSermonUrl,
        setCurrentSermon,
        updateCurrentSecond,
        sermonEnded,
        togglePlaying,
        nextSermon,
        previousSermon,
      }}
    >
      {children}
    </AudioPlayerContext.Provider>
  );
};

const useAudioPlayer = (): AudioPlayerContextType => {
  const context = useContext(AudioPlayerContext);
  if (context === undefined || context === null) {
    throw new Error('useAudioPlayer must be used within a AudioPlayerProvider');
  }
  return context;
};

export default useAudioPlayer;
