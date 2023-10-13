import { createContext, useReducer, useContext } from 'react';
import { Sermon } from '../../types/SermonTypes';
import audioPlayerReducer, { AudioPlayerState, SermonWithMetadata } from '../../reducers/audioPlayerReducer';
const initialState: AudioPlayerState = {
  currentSermon: undefined,
  currentSermonSecond: 0,
  playing: false,
};

type AudioPlayerContextType = {
  currentSermon: SermonWithMetadata | undefined;
  currentSecond: number;
  playing: boolean;
  setCurrentSermonUrl: (url: string) => void;
  setCurrentSermon: (sermon: Sermon | undefined) => void;
  updateCurrentSecond: (second: number) => void;
  togglePlaying: (play?: boolean) => void;
};

const AudioPlayerContext = createContext<AudioPlayerContextType | null>(null);

export const AudioPlayerProvider = ({ children }: any) => {
  const [state, dispatch] = useReducer(audioPlayerReducer, initialState);

  const updateCurrentSecond = (currentSecond: number) => {
    dispatch({ type: 'UPDATE_CURRENT_SECOND', payload: currentSecond });
  };

  const togglePlaying = (play?: boolean) => {
    if (play === undefined) {
      play = !state.playing;
    }
    dispatch({ type: 'TOGGLE_PLAYING', payload: play });
  };

  const setCurrentSermon = (sermon: Sermon | undefined) => {
    if (!sermon) {
      dispatch({ type: 'UPDATE_CURRENT_SERMON', payload: undefined });
      return;
    }
    if (state.currentSermon?.id === sermon.id) return;
    const newCurrentSermon: SermonWithMetadata = { ...sermon, currentSecond: 0 };
    dispatch({ type: 'UPDATE_CURRENT_SERMON', payload: newCurrentSermon });
  };

  const setCurrentSermonUrl = (url: string) => {
    if (!state.currentSermon) {
      // eslint-disable-next-line no-console
      console.error('No sermon found');
      return;
    }
    const sermon: SermonWithMetadata = {
      ...state.currentSermon,
      url,
    };
    dispatch({ type: 'UPDATE_CURRENT_SERMON', payload: sermon });
  };

  return (
    <AudioPlayerContext.Provider
      value={{
        currentSermon: state.currentSermon,
        currentSecond: state.currentSermonSecond,
        playing: state.playing,
        setCurrentSermonUrl,
        setCurrentSermon,
        updateCurrentSecond,
        togglePlaying,
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
