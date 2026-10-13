import { prepareCriticalRepairCatalogSourceAppend } from './criticalRepairCatalog';
import {
  getPublishingSourceStepIds,
  isDurablePublishingOperation,
  markPublishingCritical,
  getPublishingMutationOperation,
  runPublishingProviderMutation,
} from './durableOperationContext';
import { createHash } from 'node:crypto';
import axios from 'axios';
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import type { CallableRequest } from 'firebase-functions/v2/https';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { deleteFromSubsplashDomain, type DeleteFromSubsplashInputType } from '../../deleteFromSubsplash';
import { authenticateSubsplash, createAxiosConfig } from '../../subsplashUtils';
import { runWithSoundCloudAccessToken } from '../../soundcloudSecrets';
import { deleteTrack, normalizeSoundCloudAccountId } from '../../soundcloudClient';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import { uploadStatus } from '@upperroom/shared/types/SermonTypes';
import { preparePublishingAllocationRetirement } from './allocationBarrier';
import { prepareLegacySoundCloudInitialMissingObservation } from './legacySoundCloudRetention';
import type { PrivatePublishingIntent, PublishingJobRef, PublishingStepResult } from './types';
export const PUBLISHING_DELETION_RECEIPTS = 'temporalPublishingDeletionReceipts';
export interface PublishingDeletionStore {
  assertCurrent(ref: PublishingJobRef, intent: PrivatePublishingIntent): Promise<void>;
  commitCurrent(ref: PublishingJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
export interface PublishingDeletionProof {
  provider: 'subsplash' | 'soundcloud';
  remoteId: string;
  absenceConfirmed: true;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const isAbsent = (error: unknown) => [404, 410].includes(Number(object(object(error).response).status));
const repair: () => never = () => {
  throw Object.assign(new Error('Provider deletion requires authoritative identity or absence proof'), {
    code: 'PUBLISHING_PROVIDER_REPAIR_REQUIRED',
  });
};
const validateId = (id: string): void => {
  if (!id || id.length > 256 || /[\s/?#]/.test(id)) repair();
};
async function recordDeletionAbsence(
  ref: PublishingJobRef,
  store: PublishingDeletionStore,
  checkpoint: FirebaseFirestore.DocumentReference,
  scope: Record<string, unknown>,
  originalAccount: string,
  classification: 'verified_remote_absence_after_authorization' | 'observed_absent_no_delete'
): Promise<void> {
  await store.commitCurrent(ref, async (tx) => {
    const current = object((await tx.get(checkpoint)).data());
    if (
      current.ownershipConfirmedBeforeDelete !== true ||
      !['authorized', 'observed_absent', 'absence_confirmed'].includes(String(current.state)) ||
      !Object.entries(scope).every(([field, value]) => current[field] === value) ||
      current.originalAccount !== originalAccount
    )
      repair();
    tx.update(checkpoint, {
      state: 'absence_confirmed',
      absenceProof: 'authenticated_fixed_id_get_404_410',
      absenceClassification: classification,
      absenceConfirmedAtMillis: Date.now(),
    });
  });
}

/** Explicit user deletion is authorized by admission; retirement requires a separate fresh exact-ID GET. */
export async function deletePublishingSubsplashMedia(
  ref: PublishingJobRef,
  intent: PrivatePublishingIntent,
  store: PublishingDeletionStore,
  request: Pick<CallableRequest<DeleteFromSubsplashInputType>, 'data' | 'auth'>
): Promise<PublishingDeletionProof> {
  const id = request.data.subsplashId;
  validateId(id);
  await store.assertCurrent(ref, intent);
  const checkpoint = firebaseAdmin
    .firestore()
    .collection(PUBLISHING_DELETION_RECEIPTS)
    .doc(
      createHash('sha256')
        .update(JSON.stringify([ref.projectId, ref.jobId, 'subsplash', id]))
        .digest('hex')
    );
  const scope = {
    projectId: ref.projectId,
    jobId: ref.jobId,
    sermonId: intent.sermonId,
    provider: 'subsplash',
    remoteId: id,
    originalAccount: 'app:9XTSHD',
  };
  const prior = object((await checkpoint.get()).data()),
    owned =
      prior.ownershipConfirmedBeforeDelete === true &&
      Object.entries(scope).every(([key, value]) => prior[key] === value);
  const ownershipToken = await authenticateSubsplash();
  try {
    const response = await axios({
      ...createAxiosConfig(
        `https://core.subsplash.com/media/v1/media-items/${encodeURIComponent(id)}`,
        ownershipToken,
        'GET'
      ),
      timeout: 30000,
    });
    const media = object(response.data);
    if (response.status !== 200 || media.id !== id || media.app_key !== '9XTSHD') repair();
  } catch (error) {
    if (isAbsent(error)) {
      if (!owned) repair();
      await recordDeletionAbsence(
        ref,
        store,
        checkpoint,
        scope,
        'app:9XTSHD',
        'verified_remote_absence_after_authorization'
      );
      return { provider: 'subsplash', remoteId: id, absenceConfirmed: true };
    }
    throw error;
  }
  await markPublishingCritical('PUBLISHING_DELETE_CRITICAL', {
    provider: 'subsplash',
    resourceType: 'media',
    resourceId: id,
    accountId: 'app:9XTSHD',
    method: 'DELETE',
    canonicalPaths: [`sermons/${intent.sermonId}`],
  });
  await store.commitCurrent(ref, async (tx) => {
    const current = object((await tx.get(checkpoint)).data());
    if (Object.keys(current).length && !Object.entries(scope).every(([key, value]) => current[key] === value)) repair();
    if (!Object.keys(current).length) {
      const original = {
        ...scope,
        state: 'authorized',
        authorizedAtMillis: Date.now(),
        ownershipConfirmedBeforeDelete: true,
        ...(isDurablePublishingOperation()
          ? { sourceStepIds: getPublishingSourceStepIds(ref.jobId), sourceParentRef: ref }
          : {}),
      };
      const enrollment = await prepareCriticalRepairCatalogSourceAppend(tx, firebaseAdmin.firestore(), ref, {
        sourcePath: checkpoint.path,
        source: original,
      });
      tx.set(checkpoint, original);
      enrollment.commit();
    } else if (current.ownershipConfirmedBeforeDelete !== true) repair();
  });
  await store.assertCurrent(ref, intent);
  try {
    await runPublishingProviderMutation({
      operation: getPublishingMutationOperation() ?? `legacy:delete:subsplash:${id}`,
      target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: id },
      step: `delete:subsplash:${id}`,
      method: 'DELETE',
      payload: { id },
      send: async () => {
        let originalStatus: number | undefined;
        await deleteFromSubsplashDomain(request, {
          bearerToken: ownershipToken,
          onResponse: (response) => {
            originalStatus = response.status;
          },
        });
        if (originalStatus === 404 || originalStatus === 410)
          return {
            completion: 'rejected_no_effect',
            evidence: {
              transport: 'original_http_response',
              status: originalStatus,
              providerCode: 'resource_not_found',
            },
          };
        if (originalStatus !== 200 && originalStatus !== 204)
          throw new Error('PROVIDER_MUTATION_COMPLETION_UNCONFIRMED');
        return { completion: 'acknowledged', result: null };
      },
    });
  } catch (error) {
    if (
      object(error).code !== 'PROVIDER_MUTATION_REJECTED_NO_EFFECT' &&
      !(error instanceof Error && error.message === 'PROVIDER_MUTATION_REJECTED_NO_EFFECT')
    )
      throw error;
  }
  await store.assertCurrent(ref, intent);
  // Authentication failures can never stand in for a resource GET404.
  const token = await authenticateSubsplash();
  try {
    await axios({
      ...createAxiosConfig(`https://core.subsplash.com/media/v1/media-items/${encodeURIComponent(id)}`, token, 'GET'),
      timeout: 30000,
    });
  } catch (error) {
    if (isAbsent(error)) {
      await recordDeletionAbsence(
        ref,
        store,
        checkpoint,
        scope,
        'app:9XTSHD',
        'verified_remote_absence_after_authorization'
      );
      return { provider: 'subsplash', remoteId: id, absenceConfirmed: true };
    }
    throw error;
  }
  return repair();
}
/** A lost DELETE response may replay only the original fixed ID and the account bound BEFORE that DELETE. */
export async function deletePublishingSoundCloudTrack(
  ref: PublishingJobRef,
  intent: PrivatePublishingIntent,
  store: PublishingDeletionStore,
  id: string
): Promise<PublishingDeletionProof> {
  validateId(id);
  const db = firebaseAdmin.firestore(),
    checkpoint = db.collection(PUBLISHING_DELETION_RECEIPTS).doc(
      createHash('sha256')
        .update(JSON.stringify([ref.projectId, ref.jobId, 'soundcloud', id]))
        .digest('hex')
    );
  const scope = {
    projectId: ref.projectId,
    jobId: ref.jobId,
    sermonId: intent.sermonId,
    provider: 'soundcloud',
    remoteId: id,
  };
  const scoped = (value: Record<string, unknown>): boolean =>
    ['authorized', 'observed_absent', 'absence_confirmed'].includes(String(value.state)) &&
    Object.entries(scope).every(([key, entry]) => value[key] === entry) &&
    typeof value.originalAccount === 'string' &&
    !!value.originalAccount;
  const exact = (value: Record<string, unknown>): boolean =>
    scoped(value) && value.ownershipConfirmedBeforeDelete === true;
  return withSubsplashLocks([`media-item:soundcloud:${id}`], () =>
    runWithSoundCloudAccessToken(async (token) => {
      await store.assertCurrent(ref, intent);
      const headers = { Authorization: `OAuth ${token}`, Accept: 'application/json' };
      const accountResponse = await axios.get('https://api.soundcloud.com/me', {
        headers,
        timeout: 30000,
        maxRedirects: 0,
      });
      if (accountResponse.status !== 200) repair();
      const account = normalizeSoundCloudAccountId(object(accountResponse.data));
      const prior = object((await checkpoint.get()).data());
      if (Object.keys(prior).length && (!scoped(prior) || prior.originalAccount !== account)) repair();
      let track: Record<string, unknown>;
      try {
        const response = await axios.get(`https://api.soundcloud.com/tracks/${encodeURIComponent(id)}`, {
          headers,
          timeout: 30000,
          maxRedirects: 0,
        });
        if (response.status !== 200) repair();
        track = object(response.data);
      } catch (error) {
        if (isAbsent(error)) {
          if (!exact(prior) || prior.originalAccount !== account) {
            if (!Object.keys(prior).length && Number(object(object(error).response).status) === 404) {
              await store.commitCurrent(ref, async (tx) => {
                const observation = await prepareLegacySoundCloudInitialMissingObservation(tx, db, {
                  ref,
                  requestedTrackId: id,
                  originalHttpStatus: 404,
                  observedCurrentAccount: account,
                });
                observation.commit();
              });
              throw Object.assign(
                new Error(
                  'The original SoundCloud owner cannot be verified; administrator retention review is required'
                ),
                { code: 'PUBLISHING_LEGACY_SOUNDCLOUD_RETENTION_REQUIRED' }
              );
            }
            repair();
          }
          await recordDeletionAbsence(
            ref,
            store,
            checkpoint,
            scope,
            account,
            Object.keys(prior).length ? 'verified_remote_absence_after_authorization' : 'observed_absent_no_delete'
          );
          return { provider: 'soundcloud', remoteId: id, absenceConfirmed: true };
        }
        throw error;
      }
      if (
        ![track.id, track.id_str, track.urn].some((value) => value !== undefined && String(value) === id) ||
        normalizeSoundCloudAccountId(object(track.user)) !== account
      )
        repair();
      await markPublishingCritical('PUBLISHING_DELETE_CRITICAL', {
        provider: 'soundcloud',
        resourceType: 'track',
        resourceId: id,
        accountId: account,
        method: 'DELETE',
        canonicalPaths: [`sermons/${intent.sermonId}`],
      });
      await store.commitCurrent(ref, async (tx) => {
        const current = object((await tx.get(checkpoint)).data());
        if (Object.keys(current).length && (!scoped(current) || current.originalAccount !== account)) repair();
        if (!Object.keys(current).length) {
          const original = {
            ...scope,
            originalAccount: account,
            state: 'authorized',
            authorizedAtMillis: Date.now(),
            ownershipConfirmedBeforeDelete: true,
            ...(isDurablePublishingOperation()
              ? { sourceStepIds: getPublishingSourceStepIds(ref.jobId), sourceParentRef: ref }
              : {}),
          };
          const enrollment = await prepareCriticalRepairCatalogSourceAppend(tx, db, ref, {
            sourcePath: checkpoint.path,
            source: original,
          });
          tx.set(checkpoint, original);
          enrollment.commit();
        } else if (current.ownershipConfirmedBeforeDelete !== true) repair();
      });
      await store.assertCurrent(ref, intent);
      try {
        await runPublishingProviderMutation({
          operation: getPublishingMutationOperation() ?? `legacy:delete:soundcloud:${id}`,
          target: { provider: 'soundcloud', account, resourceType: 'track', resourceId: id },
          step: `delete:soundcloud:${id}`,
          method: 'DELETE',
          payload: { id },
          send: async () => {
            try {
              await deleteTrack(token, id);
            } catch (error) {
              if (!isAbsent(error)) throw error;
              return {
                completion: 'rejected_no_effect',
                evidence: {
                  transport: 'original_http_response',
                  status: Number(object(object(error).response).status),
                  providerCode: 'resource_not_found',
                },
              };
            }
            return { completion: 'acknowledged', result: null };
          },
        });
      } catch (error) {
        if (
          object(error).code !== 'PROVIDER_MUTATION_REJECTED_NO_EFFECT' &&
          !(error instanceof Error && error.message === 'PROVIDER_MUTATION_REJECTED_NO_EFFECT')
        )
          throw error;
      }
      await store.assertCurrent(ref, intent);
      try {
        await axios.get(`https://api.soundcloud.com/tracks/${encodeURIComponent(id)}`, {
          headers,
          timeout: 30000,
          maxRedirects: 0,
        });
      } catch (error) {
        if (isAbsent(error)) {
          await recordDeletionAbsence(
            ref,
            store,
            checkpoint,
            scope,
            account,
            'verified_remote_absence_after_authorization'
          );
          return { provider: 'soundcloud', remoteId: id, absenceConfirmed: true };
        }
        throw error;
      }
      return repair();
    })
  );
}

/** Cancellation repairs observed truth only. It never issues a DELETE or resumes the desired mutation. */
export async function reconcilePublishingDeletionCheckpoints(
  ref: PublishingJobRef,
  intent: PrivatePublishingIntent,
  store: PublishingDeletionStore
): Promise<PublishingStepResult> {
  await store.assertCurrent(ref, intent);
  const db = firebaseAdmin.firestore();
  const page = await db
    .collection(PUBLISHING_DELETION_RECEIPTS)
    .where('projectId', '==', ref.projectId)
    .where('jobId', '==', ref.jobId)
    .where('sermonId', '==', intent.sermonId)
    .where('state', 'in', ['authorized', 'observed_absent', 'absence_confirmed'])
    .limit(400)
    .get();
  for (const row of page.docs) {
    const journal = object(row.data()),
      id = journal.remoteId;
    if (
      journal.projectId !== ref.projectId ||
      journal.jobId !== ref.jobId ||
      journal.sermonId !== intent.sermonId ||
      typeof id !== 'string' ||
      !['subsplash', 'soundcloud'].includes(String(journal.provider))
    )
      repair();
    validateId(id);
    if (journal.ownershipConfirmedBeforeDelete !== true)
      return { state: 'blocked', code: 'PUBLISHING_CANCEL_DELETE_REPAIR_REQUIRED' };
    const provider = journal.provider as 'subsplash' | 'soundcloud';
    let absent = false;
    if (provider === 'subsplash') {
      if (journal.originalAccount !== 'app:9XTSHD') repair();
      const token = await authenticateSubsplash();
      try {
        await axios({
          ...createAxiosConfig(
            `https://core.subsplash.com/media/v1/media-items/${encodeURIComponent(id)}`,
            token,
            'GET'
          ),
          timeout: 30000,
        });
      } catch (error) {
        if (!isAbsent(error)) throw error;
        absent = true;
      }
    } else {
      absent = await runWithSoundCloudAccessToken(async (token) => {
        const headers = { Authorization: `OAuth ${token}`, Accept: 'application/json' };
        const account = normalizeSoundCloudAccountId(
          object((await axios.get('https://api.soundcloud.com/me', { headers, timeout: 30000, maxRedirects: 0 })).data)
        );
        if (account !== journal.originalAccount) repair();
        try {
          await axios.get(`https://api.soundcloud.com/tracks/${encodeURIComponent(id)}`, {
            headers,
            timeout: 30000,
            maxRedirects: 0,
          });
          return false;
        } catch (error) {
          if (!isAbsent(error)) throw error;
          return true;
        }
      });
    }
    if (!absent) return { state: 'blocked', code: 'PUBLISHING_CANCEL_DELETE_REPAIR_REQUIRED' };
    await store.commitCurrent(ref, async (tx) => {
      const current = object((await tx.get(row.ref)).data());
      if (current.state === 'reconciled') return;
      if (
        [
          'projectId',
          'jobId',
          'sermonId',
          'provider',
          'remoteId',
          'originalAccount',
          'state',
          'authorizedAtMillis',
          'ownershipConfirmedBeforeDelete',
        ].some((key) => current[key] !== journal[key])
      )
        repair();
      const sermonRef = db.collection('sermons').doc(intent.sermonId),
        sermon = await tx.get(sermonRef);
      const field = provider === 'subsplash' ? 'subsplashId' : 'soundCloudTrackId';
      const sameBinding = sermon.exists && sermon.get(field) === id;
      const retirement = sameBinding
        ? await preparePublishingAllocationRetirement(tx, db, { ref, sermonId: intent.sermonId, provider }, id)
        : () => {};
      if (sameBinding) {
        const patch =
          provider === 'subsplash'
            ? { subsplashId: FieldValue.delete(), 'status.subsplash': uploadStatus.NOT_UPLOADED }
            : {
                soundCloudTrackId: FieldValue.delete(),
                soundCloudTrackUrl: FieldValue.delete(),
                soundCloudPublication: FieldValue.delete(),
                'status.soundCloud': uploadStatus.NOT_UPLOADED,
              };
        tx.update(sermonRef, patch);
        retirement();
      }
      tx.update(row.ref, {
        state: 'reconciled',
        proof: 'confirmed_original_provider_absence',
        reconciledAtMillis: Date.now(),
        canonicalBindingCleared: sameBinding,
      });
    });
  }
  return page.size === 400
    ? { state: 'blocked', code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING' }
    : { state: 'completed' };
}
