import { getListsDestinationState, summarizePublishRun } from './sermonPublishingUi';
import { uploadStatus } from '../types/SermonTypes';
import { SermonList } from '../types/SermonList';
import { ListType, OverflowBehavior } from '../types/List';

const buildList = (overrides: Partial<SermonList>): SermonList => ({
  id: overrides.id || 'list-1',
  name: overrides.name || 'List',
  images: overrides.images || [],
  overflowBehavior: overrides.overflowBehavior || OverflowBehavior.CREATENEWLIST,
  type: overrides.type || ListType.TOPIC_LIST,
  createdAtMillis: overrides.createdAtMillis ?? 0,
  updatedAtMillis: overrides.updatedAtMillis ?? 0,
  uploadStatus: overrides.uploadStatus || { status: uploadStatus.NOT_UPLOADED },
  publishGeneration: overrides.publishGeneration ?? 0,
  subsplashId: overrides.subsplashId,
});

describe('sermonPublishingUi', () => {
  describe('getListsDestinationState', () => {
    it('reports no configured lists', () => {
      expect(getListsDestinationState([])).toEqual({
        state: 'not_configured',
        label: 'No target lists',
        details: 'This sermon is not assigned to any publish lists.',
      });
    });

    it('reports fully published lists', () => {
      const state = getListsDestinationState([
        buildList({ id: 'a', uploadStatus: { status: uploadStatus.UPLOADED, listItemId: '1' } }),
        buildList({ id: 'b', uploadStatus: { status: uploadStatus.UPLOADED, listItemId: '2' } }),
      ]);

      expect(state).toEqual({
        state: 'published',
        label: 'Published to all lists',
        details: '2 of 2 lists published',
      });
    });

    it('reports partial list publish state when some lists failed', () => {
      const state = getListsDestinationState([
        buildList({ id: 'a', uploadStatus: { status: uploadStatus.UPLOADED, listItemId: '1' } }),
        buildList({ id: 'b', uploadStatus: { status: uploadStatus.ERROR, reason: 'Boom' } }),
        buildList({ id: 'c', uploadStatus: { status: uploadStatus.NOT_UPLOADED } }),
      ]);

      expect(state).toEqual({
        state: 'partial',
        label: 'List publish needs attention',
        details: '1 of 3 lists published',
        error: '1 list publish error',
      });
    });
  });

  describe('summarizePublishRun', () => {
    it('returns success when all actionable destinations succeed', () => {
      const summary = summarizePublishRun([
        { state: 'published', label: 'Published' },
        { state: 'published', label: 'Published' },
      ]);

      expect(summary).toEqual({
        state: 'success',
        message: 'Publish everywhere completed successfully.',
      });
    });

    it('returns partial when at least one destination succeeds and one fails', () => {
      const summary = summarizePublishRun([
        { state: 'published', label: 'Published' },
        { state: 'error', label: 'Failed', error: 'Oops' },
      ]);

      expect(summary).toEqual({
        state: 'partial',
        message: 'Publish everywhere partially succeeded. Review the destination statuses below.',
      });
    });

    it('returns error when all actionable destinations fail', () => {
      const summary = summarizePublishRun([
        { state: 'error', label: 'Failed', error: 'Oops' },
        { state: 'blocked', label: 'Blocked' },
      ]);

      expect(summary).toEqual({
        state: 'error',
        message: 'Publish everywhere failed. Review the destination statuses below.',
      });
    });
  });
});
