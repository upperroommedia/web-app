import { isDeepStrictEqual as equal } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bootPolicy = require('../apps/temporal-worker/src/runtime/restored-media-boot-policy.json');

export const restoredMediaBootV2 = Object.freeze(bootPolicy);

export function restoredMediaStartupSettings(policy) {
  if (policy !== undefined && !equal(policy, restoredMediaBootV2))
    throw new Error('RESTORED_MEDIA_BOOT_POLICY_UNCONFIRMED');
  return {
    protocol: policy ? restoredMediaBootV2.protocol : 'restored-normal-media-kernel-v1',
    capacity: 'filesystem-allocation-native-audio-and-kernel-v4',
    sourceBytes: 20 * 1024 ** 3,
    outputBytes: 20 * 1024 ** 3,
    workspaceBytes: 64 * 1024 ** 3,
    headroomBytes: 16 * 1024 ** 3,
    ...(policy && { bootPolicy: restoredMediaBootV2 }),
  };
}

export function assertRestoredMediaBootChronology(attemptedAt, armCreateTime, events) {
  const nanosPerMillisecond = 1_000_000n;
  const fail = () => {
    throw new Error('RESTORED_MEDIA_BOOT_CHRONOLOGY_UNCONFIRMED');
  };
  const ns = (value) => {
    if (typeof value === 'string') {
      const at = Date.parse(value);
      if (!Number.isSafeInteger(at) || at <= 0 || new Date(at).toISOString() !== value) fail();
      return BigInt(at) * nanosPerMillisecond;
    }
    if (
      !Number.isSafeInteger(value?.seconds) ||
      value.seconds <= 0 ||
      !Number.isInteger(value.nanoseconds) ||
      value.nanoseconds < 0 ||
      value.nanoseconds >= 1_000_000_000
    )
      fail();
    return BigInt(value.seconds) * 1_000_000_000n + BigInt(value.nanoseconds);
  };
  const attempt = ns(attemptedAt),
    arm = ns(armCreateTime);
  const outer = attempt + BigInt(restoredMediaBootV2.outerWindowMs) * nanosPerMillisecond;
  const inner = arm + BigInt(restoredMediaBootV2.innerWindowMs) * nanosPerMillisecond;
  const deadline = outer < inner ? outer : inner;
  if (arm < attempt || arm >= deadline || events.length === 0) fail();
  let last = arm;
  for (const event of events) {
    const at = ns(event);
    if (at < last || at >= deadline) fail();
    last = at;
  }
}
