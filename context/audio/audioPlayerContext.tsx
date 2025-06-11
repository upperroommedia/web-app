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
      const shouldPlay = play === undefined ? !state.playing : play;
      dispatch({ type: 'TOGGLE_PLAYING', payload: shouldPlay });
    },
    [state.playing]
  );

  const setCurrentSermon = useCallback(
    (sermon: Sermon | undefined) => {
      if (!sermon) {
        dispatch({ type: 'UPDATE_CURRENT_SERMON', payload: undefined });
        return;
      }
      if (state.currentSermon?.id === sermon.id) return;
      const newCurrentSermon: SermonWithMetadata = { ...sermon, currentSecond: 0 };
      dispatch({ type: 'UPDATE_CURRENT_SERMON', payload: newCurrentSermon });
    },
    [state.currentSermon?.id]
  );

  const setCurrentSermonUrl = useCallback(
    (url: string) => {
      if (!state.currentSermon) {
        console.error('No sermon found');
        return;
      }
      const sermon: SermonWithMetadata = {
        ...state.currentSermon,
        url,
      };
      dispatch({ type: 'UPDATE_CURRENT_SERMON', payload: sermon });
    },
    [state.currentSermon]
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
