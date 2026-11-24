import bootPolicy from './restored-media-boot-policy.json';

/** Signed v2 provisioning policy. The inner window begins at the first native arm creation. */
export const RESTORED_MEDIA_BOOT_V2_POLICY = Object.freeze(bootPolicy);
export const RESTORED_MEDIA_BOOT_V2_PROTOCOL = RESTORED_MEDIA_BOOT_V2_POLICY.protocol;

export type RestoredMediaNativeTime = Readonly<{ seconds: number; nanoseconds: number }>;
export type RestoredMediaBootEventTime = string | RestoredMediaNativeTime;
export type RestoredMediaBootWindow = Readonly<{
  /** Inclusive whole-millisecond lower bound for local live checks, rounded up. */
  armAt: number;
  /** Exclusive whole-millisecond upper bound for local live checks, rounded down. */
  deadline: number;
  outerDeadline: number;
  attemptedAt: string;
  armCreateTime: RestoredMediaNativeTime;
}>;

type Clocks = { wallNow?: () => number; monotonicNow?: () => number };
const nanosPerMs = 1_000_000n;
const nanosPerSecond = 1_000_000_000n;
const maxFirestoreSeconds = 253402300799;
const fail = (): never => {
  throw new Error('RESTORED_MEDIA_BOOT_WINDOW_UNCONFIRMED');
};

/** Validate the entire policy object found in the authenticated plan. */
export function assertRestoredMediaBootPolicy(value: unknown): asserts value is typeof RESTORED_MEDIA_BOOT_V2_POLICY {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail();
  const policy = value as Record<string, unknown>;
  if (
    Object.keys(policy).sort().join(',') !== 'innerWindowMs,outerWindowMs,protocol' ||
    policy.protocol !== RESTORED_MEDIA_BOOT_V2_PROTOCOL ||
    policy.innerWindowMs !== RESTORED_MEDIA_BOOT_V2_POLICY.innerWindowMs ||
    policy.outerWindowMs !== RESTORED_MEDIA_BOOT_V2_POLICY.outerWindowMs
  )
    fail();
}

function sourceMillis(value: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0 || new Date(ms).toISOString() !== value) fail();
  return ms;
}

function nativeNanos(value: RestoredMediaNativeTime): bigint {
  if (
    !value ||
    !Number.isSafeInteger(value.seconds) ||
    value.seconds <= 0 ||
    value.seconds > maxFirestoreSeconds ||
    !Number.isInteger(value.nanoseconds) ||
    value.nanoseconds < 0 ||
    value.nanoseconds >= 1_000_000_000
  )
    fail();
  return BigInt(value.seconds) * nanosPerSecond + BigInt(value.nanoseconds);
}

export function restoredMediaOuterDeadline(attemptedAt: string): number {
  const end = sourceMillis(attemptedAt) + RESTORED_MEDIA_BOOT_V2_POLICY.outerWindowMs;
  if (end > maxFirestoreSeconds * 1000 + 999) fail();
  return end;
}

function innerEnd(armNs: bigint, outerDeadline: number): bigint {
  const outerNs = BigInt(outerDeadline) * nanosPerMs;
  const innerNs = armNs + BigInt(RESTORED_MEDIA_BOOT_V2_POLICY.innerWindowMs) * nanosPerMs;
  return innerNs < outerNs ? innerNs : outerNs;
}

/** Supply the original arm document's native createTime, including on child attachment.
 * The caller authenticates the document, original operation, instance and named START. */
export function restoredMediaBootWindow(
  attemptedAt: string,
  nativeArmCreateTime: RestoredMediaNativeTime
): RestoredMediaBootWindow {
  const outerDeadline = restoredMediaOuterDeadline(attemptedAt);
  const armNs = nativeNanos(nativeArmCreateTime);
  if (armNs < BigInt(sourceMillis(attemptedAt)) * nanosPerMs || armNs >= BigInt(outerDeadline) * nanosPerMs) fail();
  const armAt = Number((armNs + nanosPerMs - 1n) / nanosPerMs);
  const deadline = Number(innerEnd(armNs, outerDeadline) / nanosPerMs);
  return Object.freeze({
    armAt,
    deadline,
    outerDeadline,
    attemptedAt,
    armCreateTime: Object.freeze({
      seconds: nativeArmCreateTime.seconds,
      nanoseconds: nativeArmCreateTime.nanoseconds,
    }),
  });
}

/** Verify original affirmative event evidence at native precision. Equal timestamps are
 * legal when source events share a millisecond. The caller supplies the required links. */
export function assertRestoredMediaBootEventOrder(
  window: RestoredMediaBootWindow,
  events: readonly RestoredMediaBootEventTime[]
): void {
  if (!Array.isArray(events) || events.length === 0) fail();
  const armNs = nativeNanos(window.armCreateTime);
  const endNs = innerEnd(armNs, restoredMediaOuterDeadline(window.attemptedAt));
  if (armNs < BigInt(sourceMillis(window.attemptedAt)) * nanosPerMs || armNs >= endNs) fail();
  let previous = armNs;
  for (const event of events) {
    const ns = typeof event === 'string' ? BigInt(sourceMillis(event)) * nanosPerMs : nativeNanos(event);
    if (ns < previous || ns >= endNs) fail();
    previous = ns;
  }
}

/** An expiring time check. Fork permission, identity, transaction custody, and
 * single use belong to the calling process. Pass the full window for live enrollment,
 * or the absolute outer deadline while the parent is still waiting to arm. */
export function makeRestoredMediaBootClock(
  scope: number | RestoredMediaBootWindow,
  { wallNow = Date.now, monotonicNow = () => performance.now() }: Clocks = {}
): () => void {
  const canonical =
    typeof scope === 'number' ? undefined : restoredMediaBootWindow(scope.attemptedAt, scope.armCreateTime);
  if (
    typeof scope !== 'number' &&
    (!canonical ||
      canonical.armAt !== scope.armAt ||
      canonical.deadline !== scope.deadline ||
      canonical.outerDeadline !== scope.outerDeadline)
  )
    fail();
  const deadline = typeof scope === 'number' ? scope : scope.deadline;
  const earliest = canonical?.armAt ?? deadline - RESTORED_MEDIA_BOOT_V2_POLICY.outerWindowMs;
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(earliest) || earliest <= 0 || earliest >= deadline)
    fail();
  let previousWall = earliest;
  let previousMono = 0;
  let monoDeadline = Infinity;
  let expired = false;
  const check = () => {
    const mono = monotonicNow();
    const wall = wallNow();
    if (
      expired ||
      !Number.isFinite(mono) ||
      !Number.isSafeInteger(wall) ||
      wall < previousWall ||
      mono < previousMono ||
      wall >= deadline ||
      mono >= monoDeadline
    ) {
      expired = true;
      fail();
    }
    // A forward wall-clock correction may shorten the remaining monotonic budget.
    monoDeadline = Math.min(monoDeadline, mono + (deadline - wall));
    previousMono = mono;
    previousWall = wall;
  };
  check();
  return check;
}
