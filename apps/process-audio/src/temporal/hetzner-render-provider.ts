import { getYouTubeFailureDisposition } from '@upperroom/contracts/processAudioQueue';
import type { YouTubeAcquisitionError } from '../processYouTubeUrl';

export type RenderProviderOutcome = 'waiting_auth' | 'waiting_archive' | 'restricted';

export function renderProviderOutcome(error: unknown): RenderProviderOutcome | undefined {
  if (!(error instanceof Error)) return undefined;
  const evidence = (error as YouTubeAcquisitionError).youtubeAcquisitionEvidence;
  if (
    !evidence ||
    !Array.isArray(evidence.attemptedModes) ||
    typeof evidence.requiresAuthenticationRecovery !== 'boolean'
  )
    return undefined;
  switch (getYouTubeFailureDisposition(evidence).action) {
    case 'defer':
      return 'waiting_auth';
    case 'post_live_retry':
      return 'waiting_archive';
    case 'terminal':
      return 'restricted';
    default:
      return undefined;
  }
}

export function isRenderProviderOutcome(value: unknown): value is RenderProviderOutcome {
  return value === 'waiting_auth' || value === 'waiting_archive' || value === 'restricted';
}
