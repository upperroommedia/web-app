// Firestore REQUEST_TIME is identical for transforms on both documents in one transaction.
// https://firebase.google.com/docs/firestore/reference/rest/v1/Write#ServerValue
import { createRequire } from 'node:module';
const { Timestamp } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/firestore');
export function nativeCompatibilityTimestamp(value) {
  const native =
    value instanceof Timestamp &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, '_seconds') &&
    Object.hasOwn(value, '_nanoseconds');
  const plain =
    value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, 'seconds') &&
    Object.hasOwn(value, 'nanoseconds');
  if (
    (!native && !plain) ||
    !Number.isSafeInteger(value.seconds) ||
    value.seconds < -62135596800 ||
    value.seconds > 253402300799 ||
    !Number.isSafeInteger(value.nanoseconds) ||
    value.nanoseconds < 0 ||
    value.nanoseconds >= 1_000_000_000
  )
    throw new Error('Actual native compatibility timestamp is required');
  return { seconds: value.seconds, nanoseconds: value.nanoseconds };
}
export function nativeCompatibilityMilliseconds(value, rounding = 'ceil') {
  if (!['ceil', 'floor'].includes(rounding)) throw new Error('Explicit safe timestamp rounding is required');
  const stamp = nativeCompatibilityTimestamp(value);
  const result = stamp.seconds * 1000 + Math[rounding](stamp.nanoseconds / 1_000_000);
  if (!Number.isSafeInteger(result)) throw new Error('Safe native compatibility timestamp is required');
  return result;
}
function reviewedGrace(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || !Number.isSafeInteger(seconds * 1000))
    throw new Error('Full reviewed legacy execution grace must be a positive safe integer');
  return seconds;
}
export function compatibilitySettlingDeadline(cutoff, graceSeconds) {
  const deadline = nativeCompatibilityMilliseconds(cutoff) + reviewedGrace(graceSeconds) * 1000;
  if (!Number.isSafeInteger(deadline)) throw new Error('Legacy settling deadline exceeds safe integer range');
  return deadline;
}
export function compatibilityCutoffUpdates(control, mode, graceSeconds, serverTimestamp) {
  if (mode === 'durable-upgrade')
    return { controlUpdate: {}, stateUpdate: { compatibilityVerifiedAt: serverTimestamp() } };
  if (mode !== 'initial-cutover') throw new Error('Explicit compatibility release mode required');
  reviewedGrace(graceSeconds);
  if (Object.hasOwn(control, 'legacyAdmissionCutoff'))
    throw new Error('A committed or malformed legacy cutoff cannot be reset; inspect the actual atomic checkpoint');
  const cutoff = serverTimestamp();
  return {
    controlUpdate: { legacyAdmissionCutoff: cutoff },
    stateUpdate: {
      compatibilityVerifiedAt: cutoff,
      legacySettlingCutoff: cutoff,
      legacySettlingGraceSeconds: graceSeconds,
    },
  };
}
export function hasCompatibilitySettlingCheckpoint(control, state, config) {
  if (!['initial-cutover', 'durable-upgrade'].includes(config.mode) || state.mode !== config.mode)
    throw new Error('Compatibility checkpoint must match the explicit release mode');
  const afterReadiness =
    !['freezing-ui', 'ui-frozen', 'paused-for-recovery'].includes(state.phase) ||
    (state.phase === 'paused-for-recovery' && !['freezing-ui', 'ui-frozen'].includes(state.pausedFrom));
  if (config.mode === 'durable-upgrade') return Object.hasOwn(state, 'compatibilityVerifiedAt') || afterReadiness;
  return (
    Object.hasOwn(control, 'legacyAdmissionCutoff') ||
    Object.hasOwn(state, 'legacySettlingCutoff') ||
    Object.hasOwn(state, 'compatibilityVerifiedAt') ||
    afterReadiness
  );
}
export function assertCompatibilitySettlingCheckpoint(control, state, config) {
  if (state.mode !== config.mode) throw new Error('Compatibility checkpoint mode differs from the release descriptor');
  if (config.mode === 'durable-upgrade') return nativeCompatibilityMilliseconds(state.compatibilityVerifiedAt);
  if (config.mode !== 'initial-cutover') throw new Error('Explicit compatibility release mode required');
  const cutoff = nativeCompatibilityTimestamp(control.legacyAdmissionCutoff);
  const pinned = nativeCompatibilityTimestamp(state.legacySettlingCutoff);
  const verified = nativeCompatibilityTimestamp(state.compatibilityVerifiedAt);
  if (
    cutoff.seconds !== pinned.seconds ||
    cutoff.nanoseconds !== pinned.nanoseconds ||
    cutoff.seconds !== verified.seconds ||
    cutoff.nanoseconds !== verified.nanoseconds ||
    reviewedGrace(state.legacySettlingGraceSeconds) < reviewedGrace(config.legacyExecutionGraceSeconds) ||
    !Number.isSafeInteger(state.maximumLegacyExecutionSeconds) ||
    state.maximumLegacyExecutionSeconds < 540 ||
    state.legacySettlingGraceSeconds < state.maximumLegacyExecutionSeconds
  )
    throw new Error('Compatibility settling requires the exact immutable cutoff and full reviewed grace');
  const derived = compatibilitySettlingDeadline(cutoff, state.legacySettlingGraceSeconds);
  // A historical numeric field is never the clock authority and cannot shorten the native-derived grace.
  if (
    Object.hasOwn(state, 'legacySettlingDeadline') &&
    (!Number.isSafeInteger(state.legacySettlingDeadline) || state.legacySettlingDeadline < derived)
  )
    throw new Error('Historical client deadline cannot shorten the actual server cutoff grace');
  return derived;
}
export function assertCompatibilityGraceElapsed(control, state, config, actualServerReadTime) {
  const deadline = assertCompatibilitySettlingCheckpoint(control, state, config);
  if (nativeCompatibilityMilliseconds(actualServerReadTime, 'floor') < deadline)
    throw new Error('Wait for the full maximum legacy execution duration from the actual server cutoff');
  return deadline;
}
