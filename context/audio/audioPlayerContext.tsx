import { createContext, useReducer, useContext } from 'react';
import { Sermon } from '../../types/SermonTypes';
import audioPlayerReducer, { AudioPlayerState, SermonWithMetadata } from '../../reducers/audioPlayerReducer';
const initialState: AudioPlayerState = {
  playlist: [],
  currentSermonIndex: 0,
  currentSermonSecond: 0,
  playing: false,
};

type AudioPlayerContextType = {
  playlist: SermonWithMetadata[];
  currentSermon: SermonWithMetadata;
  currentSecond: number;
  playing: boolean;
  setPlaylist: (playlist: Sermon[]) => void;
  // addToPlaylist: (sermon: Sermon) => void;
  // removeFromPlaylist: (sermon: Sermon) => void;
  setCurrentSermonUrl: (url: string) => void;
  setCurrentSermon: (sermon: Sermon) => void;
  updateCurrentSecond: (second: number) => void;
  togglePlaying: (play?: boolean) => void;
  nextSermon: () => void;
  previousSermon: () => void;
};

const AudioPlayerContext = createContext<AudioPlayerContextType | null>(null);

export const AudioPlayerProvider = ({ children }: any) => {
  const [state, dispatch] = useReducer(audioPlayerReducer, initialState);

  const setPlaylist = (playlist: Sermon[]) => {
    const playlistWithMetadata = playlist.map((sermon): SermonWithMetadata => ({ ...sermon, currentSecond: 0 }));
    dispatch({ type: 'SET_PLAYLIST', payload: playlistWithMetadata });
  };

  const updateCurrentSecond = (currentSecond: number) => {
    dispatch({ type: 'UPDATE_CURRENT_SECOND', payload: currentSecond });
  };

  const togglePlaying = (play?: boolean) => {
    if (play === undefined) {
      play = !state.playing;
    }
    dispatch({ type: 'TOGGLE_PLAYING', payload: play });
  };

  const setCurrentSermon = (sermon: Sermon) => {
    if (state.playlist[state.currentSermonIndex].id === sermon.id) return;
    const currentSermonIndex = state.playlist.findIndex((s: SermonWithMetadata) => s.id === sermon.id);
    dispatch({ type: 'SET_CURRENT_SERMON_INDEX', payload: currentSermonIndex });
  };
  const nextSermon = () => {
    dispatch({
      type: 'SET_CURRENT_SERMON_INDEX',
      payload: (state.currentSermonIndex + 1) % state.playlist.length,
    });
  };

  const previousSermon = () => {
    if (state.currentSermonIndex === 0) {
      dispatch({
        type: 'SET_CURRENT_SERMON_INDEX',
        payload: state.playlist.length - 1,
      });
    } else {
      dispatch({
        type: 'SET_CURRENT_SERMON_INDEX',
        payload: (state.currentSermonIndex - 1) % state.playlist.length,
      });
    }
  };

  const setCurrentSermonUrl = (url: string) => {
    const sermon: SermonWithMetadata = {
      ...state.playlist[state.currentSermonIndex],
      url,
    };
    dispatch({ type: 'UPDATE_CURRENT_SERMON', payload: sermon });
  };

  return (
    <AudioPlayerContext.Provider
      value={{
        playlist: state.playlist,
        currentSermon: state.playlist[state.currentSermonIndex],
        currentSecond: state.currentSermonSecond,
        playing: state.playing,
        setPlaylist,
        // addToPlaylist,
        // removeFromPlaylist,
        setCurrentSermonUrl,
        setCurrentSermon,
        updateCurrentSecond,
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
