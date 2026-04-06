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
    it('creates a fresh upload key for each invocation', () => {
      const first = createSubsplashUploadIntentKey('manage-publishing-upload', 'sermon-1', 0);
      const second = createSubsplashUploadIntentKey('manage-publishing-upload', 'sermon-1', 0);

      expect(first).toMatch(/^manage-publishing-upload:sermon-1:[a-f0-9-]{36}$/);
      expect(second).toMatch(/^manage-publishing-upload:sermon-1:[a-f0-9-]{36}$/);
      expect(first).not.toBe(second);
    });

    it('keeps upload keys fresh even when the upload generation advances', () => {
      const first = createSubsplashUploadIntentKey('manage-publishing-upload', 'sermon-1', 0);
      const second = createSubsplashUploadIntentKey('manage-publishing-upload', 'sermon-1', 1);

      expect(first).not.toBe(second);
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

    it('creates a fresh list-remove key for each invocation even when the destination set is unchanged', () => {
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

      expect(first).toMatch(/^manage-publishing-list-remove:sermon-1:[a-f0-9-]{36}$/);
      expect(second).toMatch(/^manage-publishing-list-remove:sermon-1:[a-f0-9-]{36}$/);
      expect(first).not.toBe(second);
    });

    it('creates a fresh delete key for each invocation', () => {
      const first = createSubsplashDeleteIntentKey('manage-publishing-delete', 'sermon-1');
      const second = createSubsplashDeleteIntentKey('manage-publishing-delete', 'sermon-1');

      expect(first).toMatch(/^manage-publishing-delete:sermon-1:[a-f0-9-]{36}$/);
      expect(second).toMatch(/^manage-publishing-delete:sermon-1:[a-f0-9-]{36}$/);
      expect(first).not.toBe(second);
    });

    it('reuses the same series create key for the same series', () => {
      expect(
        createSubsplashSeriesCreateIntentKey('manage-publishing-series-create', 'series-1')
      ).toBe(
        createSubsplashSeriesCreateIntentKey('manage-publishing-series-create', 'series-1')
      );
    });

    it('creates fresh series publish/rollback/unpublish keys for each invocation', () => {
      const publishFirst = createSubsplashSeriesPublishIntentKey(
        'manage-publishing-series-publish',
        'sermon-1',
        'series-1'
      );
      const publishSecond = createSubsplashSeriesPublishIntentKey(
        'manage-publishing-series-publish',
        'sermon-1',
        'series-1'
      );
      const rollbackFirst = createSubsplashSeriesRollbackIntentKey(
        'manage-publishing-series-rollback',
        'sermon-1',
        'series-1'
      );
      const rollbackSecond = createSubsplashSeriesRollbackIntentKey(
        'manage-publishing-series-rollback',
        'sermon-1',
        'series-1'
      );
      const unpublishFirst = createSubsplashSeriesUnpublishIntentKey(
        'manage-publishing-series-unpublish',
        'sermon-1',
        'series-1'
      );
      const unpublishSecond = createSubsplashSeriesUnpublishIntentKey(
        'manage-publishing-series-unpublish',
        'sermon-1',
        'series-1'
      );

      expect(publishFirst).toMatch(/^manage-publishing-series-publish:sermon-1:[a-f0-9-]{36}$/);
      expect(publishSecond).toMatch(/^manage-publishing-series-publish:sermon-1:[a-f0-9-]{36}$/);
      expect(publishFirst).not.toBe(publishSecond);
      expect(rollbackFirst).toMatch(/^manage-publishing-series-rollback:sermon-1:[a-f0-9-]{36}$/);
      expect(rollbackSecond).toMatch(/^manage-publishing-series-rollback:sermon-1:[a-f0-9-]{36}$/);
      expect(rollbackFirst).not.toBe(rollbackSecond);
      expect(unpublishFirst).toMatch(/^manage-publishing-series-unpublish:sermon-1:[a-f0-9-]{36}$/);
      expect(unpublishSecond).toMatch(/^manage-publishing-series-unpublish:sermon-1:[a-f0-9-]{36}$/);
      expect(unpublishFirst).not.toBe(unpublishSecond);
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
