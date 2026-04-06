import { uploadStatus } from '../types/SermonTypes';
import {
  createSubsplashDeleteIntentKey,
  createSubsplashListAddIntentKey,
  createSubsplashListCreateIntentKey,
  createSubsplashListRemoveIntentKey,
  createSubsplashSeriesCreateIntentKey,
  createSubsplashSeriesPublishIntentKey,
  createSubsplashSeriesReorderIntentKey,
  createSubsplashSeriesRollbackIntentKey,
  createSubsplashSeriesUnpublishIntentKey,
  createSubsplashUploadIntentKey,
  didAllListPublishesSucceed,
  getNextPublishGeneration,
  getSermonSubsplashStatusAfterListMutation,
  summarizeListPublishErrors,
} from './subsplashPublishFlow';

describe('subsplashPublishFlow', () => {
  describe('intent keys', () => {
    it('reuses the same upload key for the same sermon publish intent', () => {
      expect(
        createSubsplashUploadIntentKey('manage-publishing-upload', 'sermon-1', 0)
      ).toBe(
        createSubsplashUploadIntentKey('manage-publishing-upload', 'sermon-1', 0)
      );
    });

    it('changes the upload key when the sermon upload generation advances', () => {
      expect(
        createSubsplashUploadIntentKey('manage-publishing-upload', 'sermon-1', 0)
      ).not.toBe(
        createSubsplashUploadIntentKey('manage-publishing-upload', 'sermon-1', 1)
      );
    });

    it('reuses the same list-create key for the same local list retry', () => {
      expect(
        createSubsplashListCreateIntentKey('manage-publishing-list-create', 'sermon-1', 'list-9')
      ).toBe(
        createSubsplashListCreateIntentKey('manage-publishing-list-create', 'sermon-1', 'list-9')
      );
    });

    it('creates a fresh list-add key for each invocation even when the destination set is unchanged', () => {
      const first = createSubsplashListAddIntentKey(
        'manage-publishing-list-add',
        'sermon-1',
        [
          { id: 'list-b', publishGeneration: 2 },
          { id: 'list-a', publishGeneration: 1 },
          { id: 'list-b', publishGeneration: 2 },
        ]
      );
      const second = createSubsplashListAddIntentKey(
        'manage-publishing-list-add',
        'sermon-1',
        [
          { id: 'list-a', publishGeneration: 1 },
          { id: 'list-b', publishGeneration: 2 },
        ]
      );

      expect(first).toMatch(/^manage-publishing-list-add:sermon-1:[a-f0-9-]{36}$/);
      expect(second).toMatch(/^manage-publishing-list-add:sermon-1:[a-f0-9-]{36}$/);
      expect(first).not.toBe(second);
    });

    it('creates a fresh list-add key even when only the publish generation changes', () => {
      const first = createSubsplashListAddIntentKey(
        'manage-publishing-list-add',
        'sermon-1',
        [{ id: 'list-a', publishGeneration: 0 }]
      );
      const second = createSubsplashListAddIntentKey(
        'manage-publishing-list-add',
        'sermon-1',
        [{ id: 'list-a', publishGeneration: 1 }]
      );

      expect(first).not.toBe(second);
    });

    it('reuses the same list-remove key for the same destination set regardless of order', () => {
      const first = createSubsplashListRemoveIntentKey(
        'manage-publishing-list-remove',
        'sermon-1',
        ['list-b', 'list-a', 'list-b']
      );
      const second = createSubsplashListRemoveIntentKey(
        'manage-publishing-list-remove',
        'sermon-1',
        ['list-a', 'list-b']
      );

      expect(first).toBe(second);
    });

    it('reuses the same delete key for the same sermon delete intent', () => {
      expect(
        createSubsplashDeleteIntentKey('manage-publishing-delete', 'sermon-1')
      ).toBe(
        createSubsplashDeleteIntentKey('manage-publishing-delete', 'sermon-1')
      );
    });

    it('reuses the same series create key for the same series', () => {
      expect(
        createSubsplashSeriesCreateIntentKey('manage-publishing-series-create', 'series-1')
      ).toBe(
        createSubsplashSeriesCreateIntentKey('manage-publishing-series-create', 'series-1')
      );
    });

    it('reuses the same series publish/rollback/unpublish keys for the same sermon-series pair', () => {
      expect(
        createSubsplashSeriesPublishIntentKey('manage-publishing-series-publish', 'sermon-1', 'series-1')
      ).toBe(
        createSubsplashSeriesPublishIntentKey('manage-publishing-series-publish', 'sermon-1', 'series-1')
      );
      expect(
        createSubsplashSeriesRollbackIntentKey('manage-publishing-series-rollback', 'sermon-1', 'series-1')
      ).toBe(
        createSubsplashSeriesRollbackIntentKey('manage-publishing-series-rollback', 'sermon-1', 'series-1')
      );
      expect(
        createSubsplashSeriesUnpublishIntentKey('manage-publishing-series-unpublish', 'sermon-1', 'series-1')
      ).toBe(
        createSubsplashSeriesUnpublishIntentKey('manage-publishing-series-unpublish', 'sermon-1', 'series-1')
      );
    });

    it('creates a fresh series reorder key for each invocation even when membership is unchanged', () => {
      const first = createSubsplashSeriesReorderIntentKey(
        'manage-publishing-series-reorder',
        'series-1',
        ['media-b', 'media-a', 'media-b']
      );
      const second = createSubsplashSeriesReorderIntentKey(
        'manage-publishing-series-reorder',
        'series-1',
        ['media-a', 'media-b']
      );

      expect(first).toMatch(/^manage-publishing-series-reorder:series-1:[a-f0-9-]{36}$/);
      expect(second).toMatch(/^manage-publishing-series-reorder:series-1:[a-f0-9-]{36}$/);
      expect(first).not.toBe(second);
    });
  });

  describe('aggregate list publish state', () => {
    it('increments publish generations monotonically', () => {
      expect(getNextPublishGeneration()).toBe(1);
      expect(getNextPublishGeneration(0)).toBe(1);
      expect(getNextPublishGeneration(4)).toBe(5);
    });

    it('treats upload-only publishes as successful', () => {
      expect(didAllListPublishesSucceed([], [])).toBe(true);
      expect(getSermonSubsplashStatusAfterListMutation([], [])).toBe(uploadStatus.UPLOADED);
    });

    it('marks the sermon as error when any target list fails', () => {
      const targetListIds = ['list-a', 'list-b'];
      const results = [
        { listId: 'list-a', status: 'success' as const, listItemId: 'row-a' },
        { listId: 'list-b', status: 'error' as const, error: 'Subsplash patch failed' },
      ];

      expect(didAllListPublishesSucceed(targetListIds, results)).toBe(false);
      expect(getSermonSubsplashStatusAfterListMutation(targetListIds, results)).toBe(uploadStatus.ERROR);
      expect(summarizeListPublishErrors(targetListIds, results)).toBe('list-b: Subsplash patch failed');
    });

    it('marks the sermon as uploaded only when every target list succeeds', () => {
      const targetListIds = ['list-a', 'list-b'];
      const results = [
        { listId: 'list-a', status: 'success' as const, listItemId: 'row-a' },
        { listId: 'list-b', status: 'success' as const, listItemId: 'row-b' },
      ];

      expect(didAllListPublishesSucceed(targetListIds, results)).toBe(true);
      expect(getSermonSubsplashStatusAfterListMutation(targetListIds, results)).toBe(uploadStatus.UPLOADED);
      expect(summarizeListPublishErrors(targetListIds, results)).toBeUndefined();
    });

    it('treats missing result rows as a hard failure', () => {
      const targetListIds = ['list-a', 'list-b'];
      const results = [{ listId: 'list-a', status: 'success' as const, listItemId: 'row-a' }];

      expect(didAllListPublishesSucceed(targetListIds, results)).toBe(false);
      expect(getSermonSubsplashStatusAfterListMutation(targetListIds, results)).toBe(uploadStatus.ERROR);
      expect(summarizeListPublishErrors(targetListIds, results)).toContain('Missing publish result for lists: list-b');
    });

    it('treats unexpected result rows as a hard failure', () => {
      const targetListIds = ['list-a'];
      const results = [
        { listId: 'list-a', status: 'success' as const, listItemId: 'row-a' },
        { listId: 'list-b', status: 'success' as const, listItemId: 'row-b' },
      ];

      expect(didAllListPublishesSucceed(targetListIds, results)).toBe(false);
      expect(summarizeListPublishErrors(targetListIds, results)).toContain('Unexpected publish result for lists: list-b');
    });
  });
});
