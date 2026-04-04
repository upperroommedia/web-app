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
  const [resolvedSrcSermonId, setResolvedSrcSermonId] = useState<string | undefined>(undefined);
  const router = useRouter();
  const sermonId = currentSermon?.id;
  const sermonUrl = currentSermon?.url;

  useEffect(() => {
    let cancelled = false;

    if (!sermonId) {
      setSrc('');
      setResolvedSrcSermonId(undefined);
      return () => {
        cancelled = true;
      };
    }

    if (sermonUrl) {
      setSrc('');
      setResolvedSrcSermonId(undefined);
      return () => {
        cancelled = true;
      };
    }

    // Clear the previously resolved URL immediately so a newly selected sermon
    // can't momentarily reuse stale audio while its storage URL is loading.
    setSrc('');
    setResolvedSrcSermonId(undefined);

    getDownloadURL(ref(storage, `intro-outro-sermons/${sermonId}`))
      .then((url) => {
        if (!cancelled) {
          setSrc((prevSrc) => (prevSrc === url ? prevSrc : url));
          setResolvedSrcSermonId(sermonId);
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

  const resolvedSrc = sermonUrl || (resolvedSrcSermonId === sermonId ? src : '');

  return (
    <MediaPlayer
      load="eager"
      autoplay
      title={currentSermon?.title}
      style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
      src={resolvedSrc ? { src: resolvedSrc, type: 'audio/mpeg' } : undefined}
    >
      {children}
      {router.pathname.startsWith('/admin') && currentSermon && <DynamicBottomAudioBar />}
    </MediaPlayer>
  );
}

export default MediaPlayerComponent;
