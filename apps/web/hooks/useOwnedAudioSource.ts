import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AudioSource } from '../utils/uploadFile';
import { AudioSourceOwnership } from '../utils/audioSourceOwnership';

export function useOwnedAudioSource() {
  const [owner] = useState(
    () =>
      new AudioSourceOwnership({
        createObjectURL: (file) => URL.createObjectURL(file),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      })
  );
  const [source, publish] = useState<AudioSource>();
  const setSource = useCallback<Dispatch<SetStateAction<AudioSource | undefined>>>(
    (update) => {
      // Evaluate against the latest selection outside a React updater; updaters
      // passed to React contain no allocation or revocation side effects.
      const next = typeof update === 'function' ? update(owner.source) : update;
      publish(owner.replace(next));
    },
    [owner]
  );
  const selectFile = useCallback(
    (file: File | undefined) => {
      publish(owner.select(file));
    },
    [owner]
  );
  useEffect(() => {
    owner.activate();
    return () => owner.deactivate();
  }, [owner]);
  return [source, setSource, selectFile] as const;
}
