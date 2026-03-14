import {
  createOperationKey,
  createPublishedMembershipHash,
  createRetryIntentKey,
  parseLockBusyDetails,
} from './callableConcurrency';

describe('callableConcurrency', () => {
  describe('createOperationKey', () => {
    it('returns stable-format unique keys', () => {
      const first = createOperationKey('series:publish', 'sermon-123');
      const second = createOperationKey('series:publish', 'sermon-123');

      expect(first).toMatch(/^series-publish:sermon-123:[a-f0-9-]{36}$/);
      expect(second).toMatch(/^series-publish:sermon-123:[a-f0-9-]{36}$/);
      expect(first).not.toBe(second);
    });
  });

  describe('createRetryIntentKey', () => {
    it('returns the same key for the same explicit retry intent', () => {
      const first = createRetryIntentKey(
        'series-admin-bulk-add',
        'series-123',
        'adds:sermon-a,sermon-b|order:media-3,media-2,media-1|snapshot:media-1|media-2'
      );
      const second = createRetryIntentKey(
        'series-admin-bulk-add',
        'series-123',
        'adds:sermon-a,sermon-b|order:media-3,media-2,media-1|snapshot:media-1|media-2'
      );

      expect(first).toBe(second);
      expect(first).toMatch(/^series-admin-bulk-add:series-123:retry-[a-f0-9]{8}$/);
    });

    it('returns different keys when intent changes', () => {
      const initial = createRetryIntentKey(
        'series-admin-bulk-add',
        'series-123',
        'adds:sermon-a|order:media-2,media-1|snapshot:media-1'
      );
      const changed = createRetryIntentKey(
        'series-admin-bulk-add',
        'series-123',
        'adds:sermon-a,sermon-b|order:media-3,media-2,media-1|snapshot:media-1|media-2'
      );

      expect(initial).not.toBe(changed);
    });
  });

  describe('createPublishedMembershipHash', () => {
    it('creates deterministic hash output for a membership snapshot', () => {
      const hash = createPublishedMembershipHash([' media-2 ', 'media-1', 'media-2']);

      expect(hash).toBe('media-1|media-2');
    });
  });

  describe('parseLockBusyDetails', () => {
    it('extracts lock contention metadata from callable errors', () => {
      const parsed = parseLockBusyDetails({
        details: {
          code: 'SUBSPLASH_LOCK_BUSY',
          locked_keys: ['series:series-1', 'media-item:sermon-123'],
          wait_ms: 10_000,
          retry_after_ms: 750,
        },
      });

      expect(parsed).toEqual({
        code: 'SUBSPLASH_LOCK_BUSY',
        locked_keys: ['series:series-1', 'media-item:sermon-123'],
        wait_ms: 10_000,
        retry_after_ms: 750,
      });
    });

    it('does not misclassify non-busy errors', () => {
      expect(parseLockBusyDetails({ code: 'functions/invalid-argument' })).toBeNull();
      expect(parseLockBusyDetails({ details: { code: 'SOME_OTHER_ERROR' } })).toBeNull();
      expect(parseLockBusyDetails(new Error('boom'))).toBeNull();
    });
  });
});
