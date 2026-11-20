import {
  MissingSermonDocumentError,
  ProcessAudioAlreadyRunningError,
  ProcessAudioCancelledError,
  type ProcessAudioResult,
} from '../processAudio';
import type { LogContext } from '../context';
import { validateYouTubeMediaByteCanaryReport, type YouTubeMediaByteCanaryReport } from '../youtubeReadiness';
const denied = () => new Error('HOST_WORK_OUTCOME_UNCONFIRMED');
const modes = ['public_provider', 'cookie_provider', 'browser_fallback'];
const classes = [
  'provider_missing_or_unhealthy',
  'public_path_bot_blocked',
  'cookie_session_stale_or_challenged',
  'account_required_content',
  'post_live_archive_not_ready',
  'browser_fallback_failed',
  'unknown_youtube_extractor_failure',
];
const flags = ['youtubeBrowserPoTokenAttempted', 'youtubeCookieRefreshAttempted', 'youtubeCookieRefreshSucceeded'];
function context(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw denied();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !flags.includes(key) || typeof record[key] !== 'boolean')) throw denied();
  return record as Record<string, boolean>;
}
function evidence(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw denied();
  const value = raw as Record<string, unknown>;
  const allowed = [
    'attemptedModes',
    'requiresAuthenticationRecovery',
    'guestFailureClass',
    'authenticatedFailureClass',
    'browserFallbackFailureClass',
    'terminalFailureClass',
  ];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !Array.isArray(value.attemptedModes) ||
    value.attemptedModes.length > 3 ||
    value.attemptedModes.some((mode) => !modes.includes(mode)) ||
    new Set(value.attemptedModes).size !== value.attemptedModes.length ||
    typeof value.requiresAuthenticationRecovery !== 'boolean'
  )
    throw denied();
  for (const key of ['guestFailureClass', 'authenticatedFailureClass', 'browserFallbackFailureClass'])
    if (value[key] !== undefined && !classes.includes(value[key] as string)) throw denied();
  if (value.terminalFailureClass !== undefined && value.terminalFailureClass !== 'account_required_content')
    throw denied();
  return { ...value };
}
export interface HostOutcome {
  v: 1;
  id: string;
  kind: string;
  value?: unknown;
  flags: Record<string, boolean>;
  evidence?: Record<string, unknown>;
  browserCode?: 'auth_required' | 'session_unhealthy';
}
export function captureHostOutcome(
  id: string,
  value: ProcessAudioResult | YouTubeMediaByteCanaryReport | undefined,
  error: unknown,
  ctx: LogContext
): HostOutcome {
  const saved = Object.fromEntries(
    flags.filter((key) => typeof ctx[key] === 'boolean').map((key) => [key, ctx[key]])
  ) as Record<string, boolean>;
  if (error === undefined) return { v: 1, id, kind: 'success', value, flags: saved };
  if (error instanceof MissingSermonDocumentError) return { v: 1, id, kind: 'missing', flags: saved };
  if (error instanceof ProcessAudioAlreadyRunningError)
    return {
      v: 1,
      id,
      kind: 'already-running',
      value: { activeRequestId: error.activeRequestId, lockAgeMs: error.lockAgeMs },
      flags: saved,
    };
  if (error instanceof ProcessAudioCancelledError) return { v: 1, id, kind: 'cancelled', flags: saved };
  const original = error as
    | { youtubeAcquisitionEvidence?: unknown; browserFallbackError?: { code?: unknown } }
    | undefined;
  const item = evidence(original?.youtubeAcquisitionEvidence);
  const browserCode = original?.browserFallbackError?.code;
  return {
    v: 1,
    id,
    kind: 'failure',
    flags: saved,
    ...(item ? { evidence: item } : {}),
    ...(browserCode === 'auth_required' || browserCode === 'session_unhealthy' ? { browserCode } : {}),
  };
}
/** Only safe classified values cross IPC. Messages/stacks/SDK/provider objects
 * never do. The parent reconstructs the pre-existing HTTP error branches. */
export function consumeHostOutcome(
  raw: unknown,
  id: string,
  ctx: LogContext,
  kind: 'legacy-full' | 'canary'
): ProcessAudioResult | YouTubeMediaByteCanaryReport {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw denied();
  const item = raw as HostOutcome;
  if (
    JSON.stringify(raw).length > 8192 ||
    item.v !== 1 ||
    item.id !== id ||
    Object.keys(item).some((key) => !['v', 'id', 'kind', 'value', 'flags', 'evidence', 'browserCode'].includes(key))
  )
    throw denied();
  const saved = context(item.flags),
    safeEvidence = evidence(item.evidence);
  if (item.browserCode !== undefined && !['auth_required', 'session_unhealthy'].includes(item.browserCode))
    throw denied();
  if (item.kind === 'success') {
    if (item.evidence !== undefined || item.browserCode !== undefined) throw denied();
    if (kind === 'canary') {
      const report = validateYouTubeMediaByteCanaryReport(item.value);
      Object.assign(ctx, saved);
      return report;
    }
    const value = item.value as ProcessAudioResult;
    if (
      !value ||
      Object.keys(value).some((key) => !['alreadyProcessed', 'youtubeSuccessfulAcquisitionAuthority'].includes(key)) ||
      typeof value.alreadyProcessed !== 'boolean' ||
      (value.youtubeSuccessfulAcquisitionAuthority !== undefined &&
        !modes.includes(value.youtubeSuccessfulAcquisitionAuthority))
    )
      throw denied();
    Object.assign(ctx, saved);
    if (value.youtubeSuccessfulAcquisitionAuthority)
      ctx.youtubeSuccessfulAcquisitionAuthority = value.youtubeSuccessfulAcquisitionAuthority;
    return value;
  }
  if (kind === 'canary' || !['missing', 'already-running', 'cancelled', 'failure'].includes(item.kind)) throw denied();
  let failure: Error;
  if (item.kind === 'missing') failure = new MissingSermonDocumentError(ctx.sermonId!, `sermons/${ctx.sermonId!}`);
  else if (item.kind === 'already-running') {
    const value = item.value as { activeRequestId: string | null; lockAgeMs: number | null };
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'activeRequestId,lockAgeMs' ||
      (value.activeRequestId !== null &&
        (typeof value.activeRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.activeRequestId))) ||
      (value.lockAgeMs !== null && (!Number.isFinite(value.lockAgeMs) || value.lockAgeMs < 0))
    )
      throw denied();
    failure = new ProcessAudioAlreadyRunningError({ sermonId: ctx.sermonId!, ...value });
  } else if (item.kind === 'cancelled') failure = new ProcessAudioCancelledError();
  else failure = new Error('Audio processing failed.');
  if (
    item.kind !== 'failure' &&
    (safeEvidence || item.browserCode || (item.kind !== 'already-running' && item.value !== undefined))
  )
    throw denied();
  if (item.kind === 'failure' && item.value !== undefined) throw denied();
  if (safeEvidence) Object.assign(failure, { youtubeAcquisitionEvidence: safeEvidence });
  if (item.browserCode) Object.assign(failure, { browserFallbackError: { code: item.browserCode } });
  Object.assign(ctx, saved);
  throw failure;
}
