import { useEffect, useState } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { getDownloadURL, getStorage, ref } from '../firebase/storage';
import { MediaPlayer } from '@vidstack/react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import firestore, { doc, onSnapshot } from '../firebase/firestore';

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
    let selectedAudioPath: string | undefined;
    let requestRevision = 0;

    if (!sermonId) {
      return () => {
        cancelled = true;
      };
    }

    if (sermonUrl) {
      return () => {
        cancelled = true;
      };
    }

    // The render guard below excludes a previous sermon's URL without another
    // effect-driven render. A current source stays playable until its replacement resolves.

    const stop = onSnapshot(
      doc(firestore, 'sermons', sermonId),
      (snapshot) => {
        const artifacts = snapshot.data()?.audioArtifacts as { finalPath?: string } | undefined;
        const selectedPath = artifacts?.finalPath || `intro-outro-sermons/${sermonId}`;
        if (selectedAudioPath === selectedPath) return;
        selectedAudioPath = selectedPath;
        const revision = ++requestRevision;
        void getDownloadURL(ref(storage, selectedPath))
          .then((url) => {
            if (!cancelled && revision === requestRevision) {
              setSrc((prevSrc) => (prevSrc === url ? prevSrc : url));
              setResolvedSrcSermonId(sermonId);
            }
          })
          .catch((error) => {
            if (cancelled || revision !== requestRevision) return;
            selectedAudioPath = undefined;
            setSrc('');
            setResolvedSrcSermonId(undefined);
            // eslint-disable-next-line no-console
            console.log(error);
          });
      },
      () => {
        if (!cancelled) {
          setSrc('');
          setResolvedSrcSermonId(undefined);
        }
      }
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [sermonId, sermonUrl]);

  const resolvedSrc = sermonUrl || (resolvedSrcSermonId === sermonId ? src : '');

  return (
    <MediaPlayer
      load={currentSermon ? 'eager' : 'play'}
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
