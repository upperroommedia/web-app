import assert from 'node:assert/strict';
import { getAudioSource, validateAddIntroOutroData } from '../src/utils';
import type { ProcessAudioInputType } from '../src/types';

const payload: ProcessAudioInputType = {
  id: 'sermon-id',
  youtubeUrl: 'The Life of Union with Christ https://youtu.be/nWY8KnvYlLQ',
  startTime: 0,
  duration: 60,
};

assert.equal(validateAddIntroOutroData(payload), true);
assert.deepEqual(getAudioSource(payload), {
  id: 'sermon-id',
  source: 'https://www.youtube.com/watch?v=nWY8KnvYlLQ',
  type: 'YouTubeUrl',
});

assert.equal(
  getAudioSource({
    ...payload,
    youtubeUrl: 'https://www.youtube.com/watch?v=nWY8KnvYlLQ&t=42s',
  }).source,
  'https://www.youtube.com/watch?v=nWY8KnvYlLQ'
);
