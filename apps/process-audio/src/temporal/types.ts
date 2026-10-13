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
  | { kind: 'ready' }
  | { kind: 'completed' }
  | { kind: 'superseded' | 'deleted' | 'cancelled' }
  | { kind: 'waiting_auth'; recoveryGeneration: string | null }
  | { kind: 'waiting_archive' }
  | { kind: 'restricted' };

export interface MediaActivities {
  prepareMedia(ref: MediaJobRef): Promise<MediaOutcome>;
  acquireMedia(ref: MediaJobRef): Promise<MediaOutcome>;
  mergeMedia(ref: MediaJobRef): Promise<MediaOutcome>;
  publishMedia(ref: MediaJobRef): Promise<MediaOutcome>;
  recoverMediaAuthentication(ref: MediaJobRef): Promise<{ ready: boolean; generation: string | null }>;
  projectMediaWaiting(ref: MediaJobRef, reason: 'authentication' | 'archive', attempt: number): Promise<void>;
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
  reason?: string;
  retryAt?: string;
}
