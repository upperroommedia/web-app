import { projectSpeakerDeletionDocument, speakerDeletionReferenceMatches } from './speakerDeletionMirrors';

const input = { speakerId: 'selected', tagId: 'tag' };
describe('speaker deletion mirror ownership', () => {
  it.each([
    [{ id: 'selected', tagId: 'stale-tag' }, true],
    [{ id: 'other', tagId: 'tag', name: 'Same name' }, false],
    [{ tagId: 'tag' }, true],
    [{ name: 'Same name' }, false],
    [null, false],
  ])('uses canonical ID before legacy tag aliases: %p', (speaker, expected) => {
    expect(speakerDeletionReferenceMatches(speaker, input)).toBe(expected);
  });
  it.each(['sermons/sermon', 'lists/list/listItems/sermon', 'series/series/seriesItems/sermon'])(
    'prunes only owned references while preserving the entire %s row',
    (path) => {
      const selected = { id: 'selected', tagId: 'tag', name: 'Selected' };
      const shared = { id: 'another', tagId: 'tag', name: 'Selected' };
      const before = {
        id: 'sermon',
        speakers: [selected, shared],
        position: 7,
        audio: { url: 'private' },
        mediaItem: {
          id: 'media',
          speakers: [selected, shared],
          seriesId: 'keep-series',
          images: [{ id: 'keep-image' }],
        },
        unknown: { nested: ['unchanged'] },
      };
      expect(projectSpeakerDeletionDocument(path, before, input)).toEqual({
        ...before,
        speakers: [shared],
        mediaItem: { ...before.mediaItem, speakers: [shared] },
      });
      expect(before.speakers).toEqual([selected, shared]);
      expect(before.mediaItem.speakers).toEqual([selected, shared]);
    }
  );
  it('ignores unrelated paths and name-only references', () => {
    expect(
      projectSpeakerDeletionDocument('speakers/selected', { speakers: [{ id: 'selected' }] }, input)
    ).toBeUndefined();
    expect(projectSpeakerDeletionDocument('sermons/s', { speakers: [{ name: 'Selected' }] }, input)).toBeUndefined();
  });
});
