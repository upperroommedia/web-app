/** Only references, selections, and state codes leave activities for workflow history. */
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import type {
  PublishingMutationPlan,
  PublishingMutationRequest,
  PublishingAcknowledgedProjectionPlan,
  DurableCriticalPreparation,
  PublishingMutationEffectsClosure,
  PublishingMutationFinalSettlement,
} from './durableOperationContext';
import type { Transaction } from 'firebase-admin/firestore';
export type PublishingJobRef = DurableJobRef;
export type PublishingStep =
  | 'subsplash-media'
  | 'soundcloud-track'
  | 'lists'
  | 'series'
  | 'projection'
  | 'cleanup'
  | 'provider-audio'
  | 'delete-plan';
export type PublishingAction = 'publish' | 'unpublish' | 'delete' | 'update' | 'reconcile';
export interface PublishingPlan {
  sermonId: string;
  action: PublishingAction;
  generation: number;
  lists: boolean;
  series: boolean;
  soundcloud: boolean;
  needsMedia: boolean;
  requiresAudio: boolean;
  needsSoundCloud: boolean;
  requiresMemberships: boolean;
}
export interface PublishingStepResult {
  state: 'completed' | 'needs_review' | 'blocked' | 'failed';
  code?: string;
  /** Safe opaque receipt reference for an authorized operator resolution. */
  receiptId?: string;
  /** Original acknowledged allocation requiring a separately audited orphan disposition. */
  acknowledgementId?: string;
  /** Another admitted job owns allocation of this shared sermon/provider resource. */
  blockingJobId?: string;
  /** Exclusive mutable-provider session requiring original-completion or isolation proof. */
  mutationSessionId?: string;
  /** Cancellation reconciliation may only adopt/delete effects, never resume the desired mutation. */
  cancelOnly?: true;
}
export interface PrivatePublishingIntent {
  sermonId: string;
  action: PublishingAction;
  generation: number;
  actorUid: string;
  /** Snapshot captured by authorized admission; never returned into history. */
  payload: Record<string, unknown>;
  destinations: { listIds: string[]; seriesId?: string; soundcloud: boolean };
}
export interface PublishingDomainDependencies {
  getSourceStepIds?(): string[];
  prepareProviderMutationEffectsClosed?(
    ref: PublishingJobRef,
    tx: Transaction,
    plan: PublishingMutationEffectsClosure
  ): Promise<{ alreadyClosed: boolean; commit: () => void }>;
  abortProviderMutationPlan?(ref: PublishingJobRef, plan: { operation: string }): Promise<void>;
  prepareAcknowledgedProjectionPlan?(
    ref: PublishingJobRef,
    tx: Transaction,
    plan: PublishingAcknowledgedProjectionPlan
  ): Promise<{ projectionDigest: string; commit: () => void }>;
  beginProviderMutationPlan?(ref: PublishingJobRef, plan: PublishingMutationPlan): Promise<void>;
  runPublishingProviderMutation?<T>(ref: PublishingJobRef, request: PublishingMutationRequest<T>): Promise<T>;
  prepareProviderMutationPlanCommit?(
    ref: PublishingJobRef,
    tx: Transaction,
    plan: PublishingMutationFinalSettlement
  ): Promise<{ alreadyCommitted: boolean; commit: () => void }>;
  commitCurrent?(ref: PublishingJobRef, mutation: (tx: Transaction) => Promise<void>): Promise<void>;
  loadIntent(ref: PublishingJobRef): Promise<PrivatePublishingIntent>;
  assertCurrent(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  markCritical?(ref: PublishingJobRef, reasonCode: string, prepare?: DurableCriticalPreparation): Promise<void>;
  recordStep(ref: PublishingJobRef, step: PublishingStep, state: PublishingStepResult): Promise<void>;
  ensureSubsplashMedia(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  ensureSoundCloudTrack(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  awaitSubsplashReady(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  awaitSoundCloudReady(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  mutateLists(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  mutateSeries(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  replaceAudio(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  updateMemberships(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  updateMetadata(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  prepareDeletePlan(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  deleteProviders(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  commitProjection(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  cancelEffects(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<PublishingStepResult>;
  reconcile(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
}
