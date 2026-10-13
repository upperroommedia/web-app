/** Pure startup-safe cutover predicate shared by Firebase ingress handlers. */
export function isDomainTemporalEnabled(domain: string): boolean {
  return process.env[`TASK_ORCHESTRATOR_${domain.toUpperCase()}`] === 'temporal';
}

import type { DurableJobKind } from '@upperroom/contracts/temporal';
export function domainForKind(kind: DurableJobKind): string {
  if (kind === 'upload.create' || kind === 'audio.process' || kind === 'youtube.authRecovery') return 'media';
  if (kind.startsWith('invite.') || kind === 'role.resolve' || kind === 'role.assign' || kind === 'speaker.resolve')
    return 'accounts';
  if (kind === 'bundle.regenerate') return 'bundles';
  if (kind.startsWith('image.')) return 'images';
  if (kind.startsWith('search.')) return 'search';
  if (kind === 'email.deliver') return 'emails';
  return 'publishing';
}

/** Operation-specific domain routing is pure and reused by admission and control commands. */
export function domainForIntent(kind: DurableJobKind, payload: Record<string, unknown>): string {
  return kind === 'maintenance.run' && payload.operation === 'media_artifacts_cleanup' ? 'media' : domainForKind(kind);
}
