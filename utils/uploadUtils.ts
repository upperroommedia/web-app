import storage, { getDownloadURL, ref } from '../firebase/storage';
import { Sermon } from '../types/SermonTypes';

export async function getIntroAndOutro(sermon: Sermon): Promise<{ introRef: string; outroRef: string }> {
  let introRef = '';
  let outroRef = '';
  try {
    introRef = await getDownloadURL(ref(storage, `intros/${sermon.subtitle}_intro.mp3`));
  } catch (error) {
    try {
      introRef = await getDownloadURL(ref(storage, `intros/default_intro.mp3`));
    } catch (error) {
      throw new Error(
        'Could not find intro audio for sermon: you must have a file called "default_intro.mp3" in your storage bucket'
      );
    }
  }
  try {
    outroRef = await getDownloadURL(ref(storage, `outros/${sermon.subtitle}_outro.mp3`));
  } catch (error) {
    try {
      outroRef = await getDownloadURL(ref(storage, `outros/default_outro.mp3`));
    } catch (error) {
      throw new Error(
        'Could not find outro audio for sermon: you must have a file called "default_outro.mp3" in your storage bucket'
      );
    }
  }

  return { introRef, outroRef };
}
