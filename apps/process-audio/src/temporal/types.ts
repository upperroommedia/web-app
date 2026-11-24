/** Only references cross the durable execution boundary; source URLs stay in Firestore. */
export interface MediaJobRef {
  jobId: string;
  projectId: string;
  sermonId: string;
  revision: number;
  requestVersion: string;
}

export type MediaStage = 'preparing' | 'downloading' | 'transcoding' | 'merging' | 'publishing';
export type MediaOutcome =
  | { kind: 'ready'; hostBound?: true }
  | { kind: 'completed' }
  | { kind: 'superseded' | 'deleted' | 'cancelled' }
  | { kind: 'waiting_auth'; recoveryGeneration: string | null; hostBound?: true }
  | { kind: 'waiting_archive'; hostBound?: true }
  | { kind: 'restricted' };

export const MEDIA_ARCHIVE_RETRY_DELAYS = [
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;
export interface MediaArchiveWait {
  attempt: number;
  scheduledAt: number;
  dueAt: number;
}

export interface MediaActivities {
  prepareMedia(ref: MediaJobRef): Promise<MediaOutcome>;
  acquireMedia(
    ref: MediaJobRef,
    archiveResume?: MediaArchiveWait,
    authenticationGeneration?: string
  ): Promise<MediaOutcome>;
  mergeMedia(ref: MediaJobRef): Promise<MediaOutcome>;
  publishMedia(ref: MediaJobRef): Promise<MediaOutcome>;
  recoverMediaAuthentication(ref: MediaJobRef): Promise<{ ready: boolean; generation: string | null }>;
  projectMediaWaiting(
    ref: MediaJobRef,
    reason: 'authentication' | 'archive',
    attempt: number,
    archiveWait?: MediaArchiveWait
  ): Promise<void>;
  projectMediaFailure(ref: MediaJobRef, code: string): Promise<void>;
  cleanupMedia(ref: MediaJobRef): Promise<void>;
  registerMediaObserver(ref: MediaJobRef, workflowId: string): Promise<void>;
  readMediaObservers(ref: MediaJobRef): Promise<string[]>;
  readMediaCompletion(
    ref: MediaJobRef
  ): Promise<{ kind: 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'superseded' }>;
  requestMediaCancellation(ref: MediaJobRef): Promise<void>;
}

export interface MediaJobProjection {
  state: 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'superseded';
  stage?: MediaStage;
  progress?: number;
  measuredSeconds?: { completed: number; total: number };
  remoteYouTubeRender?: true;
  reason?: string;
  retryAt?: string;
}
