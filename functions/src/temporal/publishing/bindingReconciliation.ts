import axios from 'axios';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { FieldPath, type Transaction } from 'firebase-admin/firestore';
import type { DurableJobRef } from '@upperroom/contracts/temporal';
import { prepareProviderBindingRelease } from '../../../../packages/orchestration/src/provider-usage';
import { authenticateSubsplash, createAxiosConfig } from '../../subsplashUtils';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';
import { readProviderReceipt, PROVIDER_RECEIPTS_COLLECTION, type ProviderReceipt } from './providerReceipts';
import { PUBLISHING_CANCELLATION_RECEIPTS } from './cancellationEvidence';
const BINDINGS = 'temporalPublishingProviderBindings';
const db = () => firebaseAdmin.firestore();
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const validId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256 && !/[\s/?#]/.test(value);
const remoteId = (receipt: ProviderReceipt): string => {
  const result = object(receipt.result);
  const id =
    typeof receipt.result === 'string'
      ? receipt.result
      : result.id ?? result.listId ?? result.tagId ?? result.soundCloudTrackId ?? result.trackIdentifier;
  return validId(id) ? id : '';
};
export interface CancellationBindingStore {
  commitCurrent(ref: DurableJobRef, mutate: (tx: Transaction) => Promise<void>): Promise<void>;
}
interface Binding {
  projectId: string;
  jobId: string;
  provider: 'subsplash' | 'soundcloud';
  account: string;
  remoteId: string;
  bindingId: string;
  state: string;
  targetReceiptId?: string;
  target?: { provider: string; kind: string; remoteId: string };
}
const same = (a: Binding, b: Binding) =>
  ['projectId', 'jobId', 'provider', 'account', 'remoteId', 'bindingId', 'state', 'targetReceiptId'].every(
    (key) => a[key as keyof Binding] === b[key as keyof Binding]
  ) &&
  a.target?.provider === b.target?.provider &&
  a.target?.kind === b.target?.kind &&
  a.target?.remoteId === b.target?.remoteId;
async function release(
  ref: DurableJobRef,
  row: FirebaseFirestore.QueryDocumentSnapshot,
  store: CancellationBindingStore
): Promise<void> {
  const expected = row.data() as Binding;
  await store.commitCurrent(ref, async (tx) => {
    const current = await tx.get(row.ref);
    const binding = current.data() as Binding | undefined;
    if (!binding || binding.state === 'released') return;
    if (binding.projectId !== ref.projectId || binding.jobId !== ref.jobId || !same(binding, expected))
      throw new Error('PROVIDER_BINDING_REVIEW_CHANGED');
    if (binding.targetReceiptId && !(await targetReceiptReleased(ref, binding.targetReceiptId, tx)))
      throw new Error('PROVIDER_BINDING_TARGET_PROOF_CHANGED');
    const commit = await prepareProviderBindingRelease(tx, db(), {
      resource: {
        projectId: ref.projectId,
        provider: binding.provider,
        account: binding.account,
        remoteId: binding.remoteId,
      },
      jobId: ref.jobId,
      bindingId: binding.bindingId,
    });
    commit();
    tx.update(row.ref, {
      state: 'released',
      releasedAtMillis: Date.now(),
      releasePurpose: 'cancel_verified_association',
    });
  });
}
async function targetReceiptReleased(ref: DurableJobRef, id: string, tx?: Transaction): Promise<boolean> {
  const receipt = tx
    ? ((await tx.get(db().collection(PROVIDER_RECEIPTS_COLLECTION).doc(id))).data() as ProviderReceipt | undefined)
    : await readProviderReceipt(id);
  if (!receipt || receipt.projectId !== ref.projectId || receipt.jobId !== ref.jobId) return false;
  if (receipt.state === 'prepared') return true; // A drained cancelled execution cannot dispatch the prepared POST.
  if (receipt.state !== 'confirmed') return false;
  const checkpointRef = db().collection(PUBLISHING_CANCELLATION_RECEIPTS).doc(`${ref.jobId}-${id}`);
  const checkpoint = tx ? await tx.get(checkpointRef) : await checkpointRef.get();
  const exact =
    checkpoint.get('projectId') === ref.projectId &&
    checkpoint.get('jobId') === ref.jobId &&
    checkpoint.get('receiptId') === id &&
    checkpoint.get('remoteId') === remoteId(receipt) &&
    checkpoint.get('providerReceiptFingerprint') === receipt.fingerprint &&
    checkpoint.get('receiptRevision') === (receipt.revision ?? 0);
  return (
    exact &&
    (checkpoint.get('state') === 'deleted' ||
      (receipt.step === 'subsplash-transcode' &&
        checkpoint.get('state') === 'retained' &&
        checkpoint.get('fetchSettled') === true))
  );
}
async function targetlessAbsent(
  ref: DurableJobRef,
  binding: Binding,
  row: FirebaseFirestore.QueryDocumentSnapshot,
  store: CancellationBindingStore
): Promise<boolean> {
  const target = binding.target;
  if (!target || target.provider !== 'subsplash' || !validId(target.remoteId)) return false;
  const paths: Record<string, string> = {
    'media-item': 'media/v1/media-items',
    series: 'media/v1/media-series',
    list: 'builder/v1/lists',
    tag: 'tags/v1/tags',
    transcode: 'transcoder/v1/jobs',
  };
  const path = paths[target.kind];
  if (!path) return false;
  return withSubsplashLocks(
    [`${target.kind === 'media-item' ? 'media-item' : target.kind}:${target.remoteId}`],
    async () => {
      const token = await authenticateSubsplash();
      let body: Record<string, unknown>;
      try {
        body = object(
          (
            await axios({
              ...createAxiosConfig(
                `https://core.subsplash.com/${path}/${encodeURIComponent(target.remoteId)}`,
                token,
                'GET'
              ),
              timeout: 30000,
            })
          ).data
        );
      } catch (error) {
        const status = object(object(error).response).status;
        if (status === 404 || status === 410) return true;
        throw error;
      }
      if (body.id !== target.remoteId || body.app_key !== '9XTSHD')
        throw new Error('PROVIDER_BINDING_TARGET_OWNERSHIP_UNVERIFIED');
      if (binding.remoteId === target.remoteId) return false;
      const contains = (value: unknown): boolean =>
        Array.isArray(value)
          ? value.some(contains)
          : value && typeof value === 'object'
          ? Object.entries(value).some(
              ([key, entry]) => (key === 'id' && entry === binding.remoteId) || contains(entry)
            )
          : false;
      if (!body._embedded || typeof body._embedded !== 'object')
        throw new Error('Provider association projection unavailable');
      if (contains(body._embedded)) return false;
      if (target.kind !== 'list') return true;
      // A standard list GET does not embed every row. Traverse fixed source-list pages.
      // Never infer absence from a truncated list collection.
      const prior = row.get('listProofPage');
      const first = Number.isSafeInteger(prior) && prior >= 1 ? prior : 1;
      for (let page = first; page < first + 20; page++) {
        const query = new URLSearchParams({
          'filter[source_list]': target.remoteId,
          'page[number]': String(page),
          'page[size]': '200',
        });
        const result = object(
          (
            await axios({
              ...createAxiosConfig(`https://core.subsplash.com/builder/v1/list-rows?${query}`, token, 'GET'),
              timeout: 30000,
            })
          ).data
        );
        const rows = object(result._embedded)['list-rows'];
        if (!Array.isArray(rows)) throw new Error('PROVIDER_LIST_BINDING_PROOF_UNAVAILABLE');
        if (rows.some(contains)) return false;
        if (rows.length < 200) return true;
      }
      await store.commitCurrent(ref, async (tx) => {
        const current = await tx.get(row.ref);
        if (current.get('state') !== 'reserved') throw new Error('Provider binding changed during proof');
        tx.update(row.ref, { listProofPage: first + 20 });
      });
      throw Object.assign(new Error('List association proof requires another bounded pass'), {
        code: 'PUBLISHING_CANCEL_REFERENCE_PROOF_PENDING',
      });
    }
  );
}
/** One bounded job-ledger page; parent receipt cleanup invokes this again after each confirmed target deletion. */
export async function releaseCancelledProviderBindings(
  ref: DurableJobRef,
  store: CancellationBindingStore,
  targetReceiptId?: string
): Promise<'completed' | 'pending'> {
  const checkpoint = db()
    .collection('temporalPublishingCancellationBindingScans')
    .doc(`${ref.jobId}-${targetReceiptId ?? 'all'}`);
  const cursorDoc = await checkpoint.get(),
    cursor = cursorDoc.get('cursor') as string | undefined;
  let query = db()
    .collection(BINDINGS)
    .doc(ref.jobId)
    .collection('bindings')
    .orderBy(FieldPath.documentId())
    .limit(400);
  if (cursor) query = query.startAfter(cursor);
  if (targetReceiptId) query = query.where('targetReceiptId', '==', targetReceiptId);
  const page = await query.get();
  for (const row of page.docs) {
    const binding = row.data() as Binding;
    if (binding.state === 'released') continue;
    if (
      binding.projectId !== ref.projectId ||
      binding.jobId !== ref.jobId ||
      !validId(binding.remoteId) ||
      !validId(binding.bindingId)
    )
      throw new Error('PROVIDER_BINDING_SCOPE_INVALID');
    if (targetReceiptId && binding.targetReceiptId !== targetReceiptId) continue;
    if (
      binding.targetReceiptId
        ? await targetReceiptReleased(ref, binding.targetReceiptId)
        : await targetlessAbsent(ref, binding, row, store)
    )
      await release(ref, row, store);
  }
  const hasMore = page.size === 400;
  await store.commitCurrent(ref, async (tx) => {
    tx.set(checkpoint, {
      projectId: ref.projectId,
      jobId: ref.jobId,
      ...(hasMore ? { cursor: page.docs[page.docs.length - 1].id } : { cursor: null }),
      updatedAtMillis: Date.now(),
    });
  });
  return hasMore ? 'pending' : 'completed';
}
