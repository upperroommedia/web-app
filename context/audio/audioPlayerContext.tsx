import { createContext, useReducer, useContext, useCallback, useMemo } from 'react';
import { Sermon } from '../../types/SermonTypes';
import audioPlayerReducer, { AudioPlayerState, SermonWithMetadata } from '../../reducers/audioPlayerReducer';

const initialState: AudioPlayerState = {
  currentSermon: undefined,
  currentSermonSecond: 0,
  playing: false,
};

type AudioPlayerContextType = {
  currentSermon: SermonWithMetadata | undefined;
  currentSermonId: string | undefined;
  currentSecond: number;
  playing: boolean;
  setCurrentSermonUrl: (url: string) => void;
  setCurrentSermon: (sermon: Sermon | undefined) => void;
  updateCurrentSecond: (second: number) => void;
  togglePlaying: (play?: boolean) => void;
};

const AudioPlayerContext = createContext<AudioPlayerContextType | null>(null);

export const AudioPlayerProvider = ({ children }: { children: React.ReactNode }) => {
  const [state, dispatch] = useReducer(audioPlayerReducer, initialState);

  const updateCurrentSecond = useCallback((currentSecond: number) => {
    dispatch({ type: 'UPDATE_CURRENT_SECOND', payload: currentSecond });
  }, []);

  const togglePlaying = useCallback(
    (play?: boolean) => {
      dispatch({ type: 'TOGGLE_PLAYING', payload: play });
    },
    []
  );

  const setCurrentSermon = useCallback(
    (sermon: Sermon | undefined) => {
      dispatch({ type: 'UPDATE_CURRENT_SERMON', payload: sermon });
    },
    []
  );

  const setCurrentSermonUrl = useCallback(
    (url: string) => {
      dispatch({ type: 'SET_CURRENT_SERMON_URL', payload: url });
    },
    []
  );

  // ✅ Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo(() => ({
    currentSermon: state.currentSermon,
    currentSermonId: state.currentSermon?.id,
    currentSecond: state.currentSermonSecond,
    playing: state.playing,
    setCurrentSermonUrl,
    setCurrentSermon,
    updateCurrentSecond,
    togglePlaying,
  }), [
    state.currentSermon,
    state.currentSermonSecond,
    state.playing,
    setCurrentSermonUrl,
    setCurrentSermon,
    updateCurrentSecond,
    togglePlaying,
  ]);

  return (
    <AudioPlayerContext.Provider value={contextValue}>
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
