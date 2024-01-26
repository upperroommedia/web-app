import { useEffect, useState } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { getDownloadURL, getStorage, ref } from '../firebase/storage';
import { MediaPlayer } from '@vidstack/react';
import BottomAudioBar from './BottomAudioBar';

const storage = getStorage();
function MediaPlayerComponent({ children }: { children: React.ReactNode }) {
  const { currentSermon } = useAudioPlayer();
  const [src, setSrc] = useState('');

  useEffect(() => {
    if (!currentSermon) return;
    if (currentSermon.url !== src) {
      getDownloadURL(ref(storage, `intro-outro-sermons/${currentSermon.id}`))
        .then((url) => {
          setSrc(url);
        })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.log(error);
        });
    }
  }, [currentSermon, src]);

  return (
    <MediaPlayer
      autoplay
      title={currentSermon?.title}
      style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}
      src={{ src, type: 'audio/mpeg' }}
      viewType="audio"
    >
      {children}
      {currentSermon && <BottomAudioBar />}
    </MediaPlayer>
  );
}

export default MediaPlayerComponent;
