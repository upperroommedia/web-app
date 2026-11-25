// Keep the provider CREATE/RUN bound independent from the signed work grant.
export const mediaRecoveryExecutionWindowVersion = 'attested-task-v2';
export const mediaRecoveryStartupMillis = 180_000;
export const mediaRecoveryWorkMillis = 180_000;
export const mediaRecoveryTaskAttestationV2Mode = 'operator-ed25519-v2';

export function mediaRecoveryLaunchWindow(plan) {
  if (typeof plan?.createdAt !== 'string') return undefined;
  const startedAt = Date.parse(plan.createdAt);
  if (!Number.isFinite(startedAt) || plan.expiresAt !== startedAt + 300_000) return undefined;
  const version = plan.executionWindowVersion;
  if (version !== undefined && version !== mediaRecoveryExecutionWindowVersion) return undefined;
  if (version !== undefined && new Date(startedAt).toISOString() !== plan.createdAt) return undefined;
  return {
    version,
    startedAt,
    launchExpiresAt: plan.expiresAt,
    attestationExpiresAt: plan.expiresAt + (version === undefined ? 0 : mediaRecoveryStartupMillis),
  };
}

export function mediaRecoveryAttestedWorkExpiry(plan, certificate) {
  const window = mediaRecoveryLaunchWindow(plan);
  const issuedAt = Date.parse(certificate?.issuedAt);
  if (!window || window.version !== certificate?.executionWindowVersion || !Number.isFinite(issuedAt) ||
      issuedAt < window.startedAt || issuedAt >= window.attestationExpiresAt) return undefined;
  const expected = window.version === undefined ? window.launchExpiresAt : issuedAt + mediaRecoveryWorkMillis;
  return certificate.expiresAt === expected ? expected : undefined;
}

export function mediaRecoveryAttestationCommitIsTimely(window, certificate, stamp) {
  if (!stamp || !Number.isSafeInteger(stamp.seconds) || !Number.isInteger(stamp.nanoseconds) ||
      stamp.nanoseconds < 0 || stamp.nanoseconds >= 1_000_000_000) return false;
  const issuedAt = Date.parse(certificate.issuedAt);
  if (!Number.isFinite(issuedAt)) return false;
  const committed = BigInt(stamp.seconds) * 1_000_000_000n + BigInt(stamp.nanoseconds);
  return committed >= BigInt(issuedAt) * 1_000_000n &&
    committed <= BigInt(issuedAt + 5000) * 1_000_000n &&
    committed < BigInt(window.attestationExpiresAt) * 1_000_000n;
}
