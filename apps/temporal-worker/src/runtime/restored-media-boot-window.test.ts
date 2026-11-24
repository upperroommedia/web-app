import {
  RESTORED_MEDIA_BOOT_V2_POLICY,
  assertRestoredMediaBootEventOrder,
  assertRestoredMediaBootPolicy,
  makeRestoredMediaBootClock,
  restoredMediaBootWindow,
  restoredMediaOuterDeadline,
} from './restored-media-boot-window';

const attemptedAt = '2026-11-24T00:53:57.111Z';
const attempt = Date.parse(attemptedAt);
const stamp = (ms: number, additionalNanos = 0) => ({
  seconds: Math.floor(ms / 1000),
  nanoseconds: (ms % 1000) * 1_000_000 + additionalNanos,
});
const iso = (ms: number) => new Date(ms).toISOString();
const denial = 'RESTORED_MEDIA_BOOT_WINDOW_UNCONFIRMED';

test('the entire signed v2 boot policy must match', () => {
  expect(RESTORED_MEDIA_BOOT_V2_POLICY).toEqual({
    protocol: 'restored-normal-media-kernel-v2',
    outerWindowMs: 600_000,
    innerWindowMs: 120_000,
  });
  expect(() => assertRestoredMediaBootPolicy({ ...RESTORED_MEDIA_BOOT_V2_POLICY })).not.toThrow();
  for (const replacement of [
    { protocol: 'restored-normal-media-kernel-v1' },
    { outerWindowMs: 600_001 },
    { innerWindowMs: 120_001 },
    { startingAt: 'readback' },
  ]) {
    expect(() => assertRestoredMediaBootPolicy({ ...RESTORED_MEDIA_BOOT_V2_POLICY, ...replacement })).toThrow(denial);
  }
  expect(() => assertRestoredMediaBootPolicy({ protocol: 'restored-normal-media-kernel-v2' })).toThrow(denial);
});

test('an authenticated cold arm receives its own inner window, bounded by the original attempt', () => {
  const nativeArm = { seconds: 1795481756, nanoseconds: 847739000 };
  const window = restoredMediaBootWindow(attemptedAt, nativeArm);
  expect(window.armAt).toBe(Date.parse('2026-11-24T00:55:56.848Z'));
  expect(window.deadline).toBe(Date.parse('2026-11-24T00:57:56.847Z'));
  expect(window.outerDeadline).toBe(attempt + 600_000);
  nativeArm.nanoseconds = 0;
  expect(window.armCreateTime.nanoseconds).toBe(847739000);
  expect(() =>
    assertRestoredMediaBootEventOrder(window, ['2026-11-24T00:55:58.000Z', '2026-11-24T00:56:09.000Z'])
  ).not.toThrow();
  expect(restoredMediaBootWindow(attemptedAt, stamp(attempt + 580_000)).deadline).toBe(attempt + 600_000);
  expect(() => restoredMediaBootWindow(attemptedAt, stamp(attempt - 1, 999999))).toThrow(denial);
  expect(() => restoredMediaBootWindow(attemptedAt, stamp(attempt + 600_000))).toThrow(denial);
});

test('historical event comparisons preserve nanoseconds at both exclusive cutoffs', () => {
  const start = attempt + 1000;
  const window = restoredMediaBootWindow(attemptedAt, stamp(start, 1));
  expect(() => assertRestoredMediaBootEventOrder(window, [stamp(start, 1), stamp(start + 120_000)])).not.toThrow();
  expect(() => assertRestoredMediaBootEventOrder(window, [stamp(start)])).toThrow(denial);
  expect(() => assertRestoredMediaBootEventOrder(window, [stamp(start + 120_000, 1)])).toThrow(denial);
  expect(() => assertRestoredMediaBootEventOrder(window, [stamp(start, 8), stamp(start, 7)])).toThrow(denial);
  expect(() => assertRestoredMediaBootEventOrder(window, [])).toThrow(denial);
  const late = restoredMediaBootWindow(attemptedAt, stamp(attempt + 599_999, 999999));
  expect(() => assertRestoredMediaBootEventOrder(late, [stamp(attempt + 599_999, 999999)])).not.toThrow();
  expect(() => assertRestoredMediaBootEventOrder(late, [stamp(attempt + 600_000)])).toThrow(denial);
  expect(() => makeRestoredMediaBootClock(late)).toThrow(denial); // No local whole millisecond remains.
});

test('source timestamp encoding and native stamp ranges are checked before arithmetic', () => {
  for (const invalid of ['', '2026-02-31T00:00:00.000Z', attemptedAt.replace('Z', '+00:00')]) {
    expect(() => restoredMediaOuterDeadline(invalid)).toThrow(denial);
  }
  for (const invalid of [
    { seconds: NaN, nanoseconds: 0 },
    { seconds: 253402300800, nanoseconds: 0 },
    { seconds: 1795481756, nanoseconds: -1 },
    { seconds: 1795481756, nanoseconds: 1_000_000_000 },
    { seconds: 1795481756, nanoseconds: 0.5 },
  ])
    expect(() => restoredMediaBootWindow(attemptedAt, invalid)).toThrow(denial);
});

test('a live arm uses both clocks and cannot gain time when the wall clock stalls', () => {
  const window = restoredMediaBootWindow(attemptedAt, stamp(attempt + 9000));
  let wall = window.armAt;
  let mono = 500;
  const clocks = { wallNow: () => wall, monotonicNow: () => mono };
  const check = makeRestoredMediaBootClock(window, clocks);
  wall = window.deadline - 7;
  mono += 3;
  check();
  mono += 7;
  expect(check).toThrow(denial);
  mono -= 7;
  expect(check).toThrow(denial);
  expect(() => makeRestoredMediaBootClock({ ...window, deadline: window.deadline + 1 }, clocks)).toThrow(denial);
});

test('wall and monotonic rollback are sticky and a late read cannot renew an outer or inner clock', () => {
  const outer = restoredMediaOuterDeadline(attemptedAt);
  const window = restoredMediaBootWindow(attemptedAt, stamp(attempt + 4000));
  let wall = window.armAt;
  let mono = 100;
  const clocks = { wallNow: () => wall, monotonicNow: () => mono };
  const wallGuard = makeRestoredMediaBootClock(window, clocks);
  wall--;
  expect(wallGuard).toThrow(denial);
  wall++;
  expect(wallGuard).toThrow(denial);
  const monoGuard = makeRestoredMediaBootClock(outer, clocks);
  mono--;
  expect(monoGuard).toThrow(denial);
  mono++;
  expect(monoGuard).toThrow(denial);
  wall = window.deadline;
  expect(() => makeRestoredMediaBootClock(window, clocks)).toThrow(denial);
  wall = outer;
  expect(() => makeRestoredMediaBootClock(outer, clocks)).toThrow(denial);
  expect(() => assertRestoredMediaBootEventOrder(window, [iso(window.deadline - 1)])).not.toThrow();
});
