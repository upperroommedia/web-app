import { getSermonDateMillis } from '../../types/Sermon';

describe('getSermonDateMillis', () => {
  const fallbackMillis = 1_700_000_000_000;

  it('reads hydrated and JSON-serialized Firestore timestamps', () => {
    expect(getSermonDateMillis({ toMillis: () => 1_600_000_000_123 }, fallbackMillis)).toBe(
      1_600_000_000_123
    );
    expect(
      getSermonDateMillis({ _seconds: 1_600_000_000, _nanoseconds: 123_000_000 }, fallbackMillis)
    ).toBe(1_600_000_000_123);
  });

  it('accepts legacy scalar dates and safely falls back for malformed data', () => {
    expect(getSermonDateMillis('2026-07-25T20:44:21.390Z', fallbackMillis)).toBe(
      Date.parse('2026-07-25T20:44:21.390Z')
    );
    expect(getSermonDateMillis({ unexpected: true }, fallbackMillis)).toBe(fallbackMillis);
  });
});
