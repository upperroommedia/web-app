import { useEffect, useState } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { getDownloadURL, getStorage, ref } from '../firebase/storage';
import { MediaPlayer } from '@vidstack/react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';

const DynamicBottomAudioBar = dynamic(() => import ('./BottomAudioBar'))

const storage = getStorage();
function MediaPlayerComponent({ children }: { children: React.ReactNode }) {
  const { currentSermon } = useAudioPlayer();
  const [src, setSrc] = useState('');
  const router = useRouter()


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
      load="eager"
      autoplay
      title={currentSermon?.title}
      style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
      src={{ src, type: 'audio/mpeg' }}
    >
      {children}
      {router.pathname.startsWith('/admin') && currentSermon && <DynamicBottomAudioBar />}
    </MediaPlayer>
  );
}

export default MediaPlayerComponent;
