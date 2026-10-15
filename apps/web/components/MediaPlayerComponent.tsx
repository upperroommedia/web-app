import { useEffect, useState } from 'react';
import useAudioPlayer from '../context/audio/audioPlayerContext';
import { getDownloadURL, getStorage, ref } from '../firebase/storage';
import { AudioPlayer } from '@videojs/react/audio';
import { PlaybackFeedbackProvider } from '../context/audio/audioPlayback';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import firestore, { doc, onSnapshot } from '../firebase/firestore';

const DynamicBottomAudioBar = dynamic(() => import('./BottomAudioBar'));

const storage = getStorage();

function MediaPlayerComponent({ children }: { children: React.ReactNode }) {
  const { currentSermon } = useAudioPlayer();
  const [src, setSrc] = useState('');
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [sourceFailure, setSourceFailure] = useState<{ sermonId: string; message: string }>();
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
              setSourceFailure(undefined);
              setSrc((prevSrc) => (prevSrc === url ? prevSrc : url));
              setResolvedSrcSermonId(sermonId);
            }
          })
          .catch((error) => {
            if (cancelled || revision !== requestRevision) return;
            selectedAudioPath = undefined;
            setSourceFailure({ sermonId, message: 'Audio could not load. Select Retry audio to try again.' });
            setSrc('');
            setResolvedSrcSermonId(undefined);
            // eslint-disable-next-line no-console
            console.log(error);
          });
      },
      () => {
        // Listener failure is terminal for this subscription. A URL already in
        // flight must not later clear the error or revive playback.
        requestRevision++;
        if (!cancelled) {
          setSourceFailure({ sermonId, message: 'Audio could not load. Select Retry audio to try again.' });
          setSrc('');
          setResolvedSrcSermonId(undefined);
        }
      }
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [sermonId, sermonUrl, sourceAttempt]);

  const resolvedSrc = sermonUrl || (resolvedSrcSermonId === sermonId ? src : '');

  return (
    <AudioPlayer title={currentSermon?.title}>
      <PlaybackFeedbackProvider sourceKey={`${sermonId || ''}:${resolvedSrc}`}>
        <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
          {children}
          {router.pathname.startsWith('/admin') && currentSermon && (
            <DynamicBottomAudioBar
              source={resolvedSrc}
              sermonId={sermonId}
              onRetrySource={() => {
                setSourceFailure(undefined);
                setSourceAttempt((attempt) => attempt + 1);
              }}
              sourceError={
                !sermonUrl && sourceFailure && sourceFailure.sermonId === sermonId ? sourceFailure.message : undefined
              }
            />
          )}
        </div>
      </PlaybackFeedbackProvider>
    </AudioPlayer>
  );
}

export default MediaPlayerComponent;
