// The immutable provider launch plan keeps its original five-minute cutoff.
// A v2 certificate may be issued during the bounded startup window and grants
// one fixed work window to the original acknowledged native task.
export const mediaRecoveryExecutionWindowVersion = 'attested-task-v2';
export const mediaRecoveryLaunchMillis = 300_000;
export const mediaRecoveryStartupMillis = 180_000;
export const mediaRecoveryWorkMillis = 180_000;

type WindowPlan = { createdAt?: unknown; expiresAt?: unknown; executionWindowVersion?: unknown };
type WindowCertificate = { issuedAt: string; expiresAt: number; executionWindowVersion?: unknown };

export function mediaRecoveryLaunchWindow(plan: WindowPlan | null | undefined) {
  if (typeof plan?.createdAt !== 'string') return undefined;
  const startedAt = Date.parse(plan.createdAt);
  if (!Number.isFinite(startedAt) || plan.expiresAt !== startedAt + mediaRecoveryLaunchMillis) return undefined;
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

export function mediaRecoveryAttestedWorkExpiry(plan: WindowPlan, certificate: WindowCertificate) {
  const window = mediaRecoveryLaunchWindow(plan);
  const issuedAt = Date.parse(certificate.issuedAt);
  if (!window || window.version !== certificate.executionWindowVersion || !Number.isFinite(issuedAt) ||
      issuedAt < window.startedAt || issuedAt >= window.attestationExpiresAt) return undefined;
  const expected = window.version === undefined ? window.launchExpiresAt : issuedAt + mediaRecoveryWorkMillis;
  return certificate.expiresAt === expected ? expected : undefined;
}

/** Legacy work consumed the launch window. A v2 plan alone never grants work. */
export function mediaRecoveryExecutionExpiry(plan: WindowPlan, attestedExpiry?: number) {
  const window = mediaRecoveryLaunchWindow(plan);
  if (!window) return undefined;
  if (window.version === undefined) return window.launchExpiresAt;
  if (attestedExpiry === undefined || !Number.isSafeInteger(attestedExpiry) ||
      attestedExpiry < window.startedAt + mediaRecoveryWorkMillis ||
      attestedExpiry >= window.attestationExpiresAt + mediaRecoveryWorkMillis) return undefined;
  return attestedExpiry;
}

export function mediaRecoveryAttestationCommitIsTimely(window: NonNullable<ReturnType<typeof mediaRecoveryLaunchWindow>>,
  certificate: WindowCertificate,
  stamp: { seconds: number; nanoseconds: number } | undefined
) {
  if (!stamp || !Number.isSafeInteger(stamp.seconds) || !Number.isInteger(stamp.nanoseconds) ||
      stamp.nanoseconds < 0 || stamp.nanoseconds >= 1_000_000_000) return false;
  const issuedAt = Date.parse(certificate.issuedAt);
  if (!Number.isFinite(issuedAt)) return false;
  const committed = BigInt(stamp.seconds) * 1_000_000_000n + BigInt(stamp.nanoseconds);
  return committed >= BigInt(issuedAt) * 1_000_000n &&
    committed <= BigInt(issuedAt + 5000) * 1_000_000n &&
    committed < BigInt(window.attestationExpiresAt) * 1_000_000n;
}
