import { createOperationKey, parseLockBusyDetails } from './callableConcurrency';

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
