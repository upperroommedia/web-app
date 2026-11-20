/** Shared Temporal ownership gate for admission and already-admitted continuations. */
export const TEMPORAL_RELEASE_CONTROL_PATH = '_control/temporalRelease';
export interface TemporalReleaseControl {
  schemaVersion: 1;
  revision: number;
  admission: 'open' | 'paused';
  domains: Record<string, { owner: 'temporal' | 'legacy'; admission: 'open' | 'paused' }>;
  updatedAt: number;
  releaseId: string;
  legacyAdmissionCutoff?: { seconds: number; nanoseconds: number };
}
export class TemporalReleaseAdmissionError extends Error {
  constructor(readonly code: 'failed-precondition' | 'unavailable', message: string) {
    super(message);
  }
}
export function assertTemporalReleaseAdmission(
  control: TemporalReleaseControl | undefined,
  domain: string,
  options: { continuation?: boolean } = {}
): void {
  const state = control?.domains?.[domain];
  if (
    !control ||
    control.schemaVersion !== 1 ||
    !Number.isSafeInteger(control.revision) ||
    control.revision < 1 ||
    state?.owner !== 'temporal'
  )
    throw new TemporalReleaseAdmissionError(
      'failed-precondition',
      'This operation is not owned by the active Temporal release. Refresh before starting new work.'
    );
  if (!options.continuation && (control.admission !== 'open' || state.admission !== 'open'))
    throw new TemporalReleaseAdmissionError(
      'unavailable',
      'New tasks are paused for a release change. Your existing tasks remain available; try again after the release is ready.'
    );
}
