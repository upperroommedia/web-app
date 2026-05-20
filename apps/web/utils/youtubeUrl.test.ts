import { extractYouTubeVideoId, normalizeYouTubeUrl } from './youtubeUrl';

describe('youtubeUrl helpers', () => {
  it('normalizes pasted title text plus a YouTube short URL', () => {
    expect(normalizeYouTubeUrl('The Life of Union with Christ https://youtu.be/nWY8KnvYlLQ')).toBe(
      'https://www.youtube.com/watch?v=nWY8KnvYlLQ'
    );
  });

  it('normalizes supported YouTube URL formats', () => {
    expect(normalizeYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
    expect(normalizeYouTubeUrl('https://www.youtube.com/shorts/qnmolZF_a0w')).toBe(
      'https://www.youtube.com/watch?v=qnmolZF_a0w'
    );
    expect(normalizeYouTubeUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('rejects non-YouTube URLs and arbitrary text', () => {
    expect(extractYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(extractYouTubeVideoId('not a youtube value')).toBeNull();
  });
});
