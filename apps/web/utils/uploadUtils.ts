import storage, { getDownloadURL, ref } from '../firebase/storage';
import { Sermon } from '../types/SermonTypes';

export async function getIntroAndOutro(sermon: Sermon): Promise<{ introRef: string; outroRef: string }> {
  let introRef = '';
  let outroRef = '';
  try {
    introRef = await getDownloadURL(ref(storage, `intros/${sermon.subtitle}_intro.mp3`));
  } catch (_error) {
    try {
      introRef = await getDownloadURL(ref(storage, `intros/default_intro.mp3`));
    } catch (_error) {
      throw new Error(
        'Could not find intro audio for sermon: you must have a file called "default_intro.mp3" in your storage bucket'
      );
    }
  }
  try {
    outroRef = await getDownloadURL(ref(storage, `outros/${sermon.subtitle}_outro.mp3`));
  } catch (_error) {
    try {
      outroRef = await getDownloadURL(ref(storage, `outros/default_outro.mp3`));
    } catch (_error) {
      throw new Error(
        'Could not find outro audio for sermon: you must have a file called "default_outro.mp3" in your storage bucket'
      );
    }
  }

  return { introRef, outroRef };
}

/** Prefer the immutable result of the current server-owned audio generation. */
export function getSermonFinalAudioPath(
  sermon: Pick<Sermon, 'id'> & { audioArtifacts?: { finalPath?: string } }
): string {
  return sermon.audioArtifacts?.finalPath || `intro-outro-sermons/${sermon.id}`;
}

/** Original bytes are a separate artifact and must remain distinct from processed audio. */
export function getSermonSourceAudioPath(
  sermon: Pick<Sermon, 'id'> & { audioArtifacts?: { sourcePath?: string } }
): string {
  return sermon.audioArtifacts?.sourcePath || `sermons/${sermon.id}`;
}
