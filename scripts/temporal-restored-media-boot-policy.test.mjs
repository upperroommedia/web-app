import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertRestoredMediaBootChronology,
  restoredMediaBootV2,
  restoredMediaStartupSettings,
} from './temporal-restored-media-boot-policy.mjs';

const attempt = '2026-11-24T00:53:57.111Z';
const offsets = (ms) => new Date(Date.parse(attempt) + ms).toISOString();
const native = (ms, nanos = 0) => {
  const time = Date.parse(attempt) + ms;
  return { seconds: Math.floor(time / 1000), nanoseconds: (time % 1000) * 1_000_000 + nanos };
};

test('the existing startup settings and storage budgets retain their original shape', () => {
  assert.deepEqual(restoredMediaStartupSettings(), {
    protocol: 'restored-normal-media-kernel-v1',
    capacity: 'filesystem-allocation-native-audio-and-kernel-v4',
    sourceBytes: 20 * 1024 ** 3,
    outputBytes: 20 * 1024 ** 3,
    workspaceBytes: 64 * 1024 ** 3,
    headroomBytes: 16 * 1024 ** 3,
  });
  assert.deepEqual(restoredMediaStartupSettings({ ...restoredMediaBootV2 }).bootPolicy, restoredMediaBootV2);
  assert.throws(
    () => restoredMediaStartupSettings({ ...restoredMediaBootV2, outerWindowMs: 600001 }),
    /BOOT_POLICY_UNCONFIRMED/
  );
});

test('a cold provider boot can enroll using its first native arm creation time', () => {
  assert.doesNotThrow(() =>
    assertRestoredMediaBootChronology(attempt, native(119736, 739000), [
      offsets(120200),
      native(128000, 1),
      offsets(171000),
      offsets(171100),
      native(171110),
    ])
  );
});

test('a receipt arriving at the exact inner or outer deadline cannot qualify', () => {
  const arm = native(119736, 739000);
  assert.doesNotThrow(() => assertRestoredMediaBootChronology(attempt, arm, [offsets(239736), native(239736, 738999)]));
  assert.throws(
    () => assertRestoredMediaBootChronology(attempt, arm, [offsets(239736), native(239736, 739000)]),
    /BOOT_CHRONOLOGY_UNCONFIRMED/
  );
  assert.throws(
    () => assertRestoredMediaBootChronology(attempt, native(590000), [offsets(599997), native(600000)]),
    /BOOT_CHRONOLOGY_UNCONFIRMED/
  );
});

test('missing native timestamps and native commits that predate reported work fail closed', () => {
  for (const events of [[], [offsets(2), null], [offsets(2), native(1, 999999)]]) {
    assert.throws(() => assertRestoredMediaBootChronology(attempt, native(1), events), /BOOT_CHRONOLOGY_UNCONFIRMED/);
  }
});
