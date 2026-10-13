import { buildSermonPublishIntent, hasPublishIntentChanges } from '../../utils/sermonPublishIntent';
import { emptySermonList } from '../../types/SermonList';
import { uploadStatus } from '../../types/SermonTypes';

const lists = [
  {
    ...emptySermonList,
    id: 'published',
    uploadStatus: { status: uploadStatus.UPLOADED as const, listItemId: 'remote' },
  },
  { ...emptySermonList, id: 'new' },
];
const input = {
  lists,
  selectedListIds: ['published', 'new'],
  seriesId: 'series',
  seriesSelected: true,
  seriesPublished: false,
  soundcloudSelected: true,
  soundcloudPublished: false,
};
describe('durable publish selection', () => {
  it('submits canonical additions without re-creating completed destinations', () => {
    expect(buildSermonPublishIntent(input)).toEqual({
      destinations: { listIds: ['new'], seriesId: 'series', soundcloud: true },
      removals: { listIds: [], soundcloud: false },
    });
  });
  it('preserves an explicit empty selection and requests removal of published destinations', () => {
    const payload = buildSermonPublishIntent({
      ...input,
      selectedListIds: [],
      seriesSelected: false,
      seriesPublished: true,
      soundcloudSelected: false,
      soundcloudPublished: true,
    });
    expect(payload).toEqual({
      destinations: { listIds: [], soundcloud: false },
      removals: { listIds: ['published'], seriesId: 'series', soundcloud: true },
    });
  });
  it('ignores selected IDs no longer in canonical memberships', () => {
    const payload = buildSermonPublishIntent({
      ...input,
      selectedListIds: ['removed', 'published'],
      seriesPublished: true,
      soundcloudPublished: true,
    });
    expect(hasPublishIntentChanges(payload)).toBe(false);
  });
  it('keeps additions and removals together in one durable request', () => {
    const payload = buildSermonPublishIntent({ ...input, selectedListIds: ['new'], seriesPublished: true });
    expect(payload.destinations.listIds).toEqual(['new']);
    expect(payload.removals.listIds).toEqual(['published']);
    expect(hasPublishIntentChanges(payload)).toBe(true);
  });
});
