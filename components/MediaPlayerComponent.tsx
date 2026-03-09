import { useEffect, useState } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { getDownloadURL, getStorage, ref } from '../firebase/storage';
import { MediaPlayer } from '@vidstack/react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';

const DynamicBottomAudioBar = dynamic(() => import('./BottomAudioBar'));

const storage = getStorage();

function MediaPlayerComponent({ children }: { children: React.ReactNode }) {
  const { currentSermon } = useAudioPlayer();
  const [src, setSrc] = useState('');
  const router = useRouter();
  const sermonId = currentSermon?.id;
  const sermonUrl = currentSermon?.url;

  useEffect(() => {
    let cancelled = false;

    if (!sermonId && !sermonUrl) {
      setSrc('');
      return () => {
        cancelled = true;
      };
    }

    if (sermonUrl) {
      setSrc((prevSrc) => (prevSrc === sermonUrl ? prevSrc : sermonUrl));
      return () => {
        cancelled = true;
      };
    }
    if (!sermonId) {
      return () => {
        cancelled = true;
      };
    }

    getDownloadURL(ref(storage, `intro-outro-sermons/${sermonId}`))
      .then((url) => {
        if (!cancelled) {
          setSrc((prevSrc) => (prevSrc === url ? prevSrc : url));
        }
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.log(error);
      });

    return () => {
      cancelled = true;
    };
  }, [sermonId, sermonUrl]);

  return (
    <MediaPlayer
      load="eager"
      autoplay
      title={currentSermon?.title}
      style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
      src={src ? { src, type: 'audio/mpeg' } : undefined}
    >
      {children}
      {router.pathname.startsWith('/admin') && currentSermon && <DynamicBottomAudioBar />}
    </MediaPlayer>
  );
}

export default MediaPlayerComponent;
