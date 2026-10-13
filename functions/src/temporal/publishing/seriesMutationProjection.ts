import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import type { Transaction } from 'firebase-admin/firestore';
import type { ProviderMutationResource } from './providerMutationGuard';
import type { FrozenProjectionWrite } from './criticalAcknowledgedRepair';
import {
  getPublishingMutationOperation,
  isDurablePublishingOperation,
  publishingMutationRequestFingerprint,
  prepareAcknowledgedProjectionPlan,
  runDurableTransaction,
} from './durableOperationContext';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
function reject(): never {
  throw new Error('PROVIDER_ACK_PROJECTION_CONTEXT_REQUIRED');
}
/** Freeze factual series tracking before the original provider request is claimed. */
export async function freezeSeriesMutationProjection(
  target: ProviderMutationResource,
  step: string,
  method: 'PATCH' | 'DELETE',
  payload: unknown,
  canonicalPatch: Record<string, unknown> = {}
): Promise<void> {
  if (!isDurablePublishingOperation()) return;
  const operation = getPublishingMutationOperation();
  if (!operation) reject();
  const db = firebaseAdmin.firestore(),
    data = object(payload),
    writes: FrozenProjectionWrite[] = [];
  await runDurableTransaction(db, async (tx: Transaction) => {
    const matches = await tx.get(
      db
        .collection(target.resourceType === 'media' ? 'sermons' : 'series')
        .where('subsplashId', '==', target.resourceId)
    );
    if (matches.size !== 1) reject();
    const canonical = matches.docs[0],
      current = object(canonical.data());
    const expectedFields: Record<string, unknown> = { subsplashId: target.resourceId };
    const patch: Record<string, unknown> = { subsplashId: target.resourceId, ...canonicalPatch };
    const deleteFields: string[] = [];
    if (target.resourceType === 'series') {
      if (method === 'DELETE')
        writes.push({ path: canonical.ref.path, mode: 'delete', expectedExists: true, expectedFields, patch: {} });
      else {
        if (typeof data.title === 'string') patch.name = data.title;
        if (typeof data.subtitle === 'string') patch.subtitle = data.subtitle;
        if (data.summary === null) deleteFields.push('summary');
        else if (typeof data.summary === 'string') patch.summary = data.summary;
        const positions = object(data._embedded)['media-items'];
        if (Array.isArray(positions)) {
          const rows = await tx.get(canonical.ref.collection('seriesItems'));
          for (const position of positions) {
            const item = object(position);
            if (typeof item.id !== 'string' || (item.position !== null && typeof item.position !== 'number')) reject();
            const row = rows.docs.find((row) => row.get('sermonSubsplashId') === item.id);
            if (!row) reject();
            writes.push({
              path: row.ref.path,
              expectedExists: true,
              expectedFields: { sermonSubsplashId: item.id },
              patch: { position: item.position },
            });
          }
        }
        writes.push({ path: canonical.ref.path, expectedExists: true, expectedFields, patch, deleteFields });
      }
    } else {
      const association = object(data._embedded)['media-series'];
      if (association === null) {
        patch.seriesPublishedToSubsplash = false;
      } else if (typeof object(association).id === 'string') {
        const series = await tx.get(db.collection('series').where('subsplashId', '==', object(association).id));
        if (series.size !== 1) reject();
        patch.seriesId = series.docs[0].id;
        patch.seriesPublishedToSubsplash = true;
        const row = series.docs[0].ref.collection('seriesItems').doc(canonical.id),
          snapshot = await tx.get(row);
        if (snapshot.exists) {
          writes.push({
            path: row.path,
            expectedExists: true,
            expectedFields: {},
            patch: {
              publishedToSubsplash: true,
              sermonSubsplashId: target.resourceId,
              ...(typeof data.position === 'number' ? { position: data.position } : {}),
            },
          });
        } else {
          const members = await tx.get(series.docs[0].ref.collection('seriesItems'));
          const position =
            typeof data.position === 'number'
              ? data.position
              : Math.max(0, ...members.docs.map((row) => Number(row.get('position')) || 0)) + 1;
          writes.push({
            path: row.path,
            mode: 'set',
            expectedExists: false,
            expectedFields: {},
            patch: { id: canonical.id, position, publishedToSubsplash: true, sermonSubsplashId: target.resourceId },
          });
        }
        if (typeof current.seriesId === 'string' && current.seriesId !== series.docs[0].id) {
          const oldRow = db.collection('series').doc(current.seriesId).collection('seriesItems').doc(canonical.id),
            old = await tx.get(oldRow);
          if (old.exists)
            writes.push({
              path: oldRow.path,
              expectedExists: true,
              expectedFields: {},
              patch: { publishedToSubsplash: false },
            });
        }
      }
      if (typeof data.position === 'number') {
        const seriesId = current.seriesId;
        if (typeof seriesId === 'string') {
          const row = db.collection('series').doc(seriesId).collection('seriesItems').doc(canonical.id);
          const snapshot = await tx.get(row);
          if (snapshot.exists)
            writes.push({
              path: row.path,
              expectedExists: true,
              expectedFields: {},
              patch: { position: data.position },
            });
        }
      }
      if (association === null && typeof current.seriesId === 'string') {
        const row = db.collection('series').doc(current.seriesId).collection('seriesItems').doc(canonical.id),
          snapshot = await tx.get(row);
        if (snapshot.exists)
          writes.push({
            path: row.path,
            expectedExists: true,
            expectedFields: {},
            patch: { publishedToSubsplash: false },
          });
      }
      writes.push({ path: canonical.ref.path, expectedExists: true, expectedFields, patch });
    }
    for (const write of writes) {
      if (write.mode === 'delete' || write.expectedExists === false) continue;
      const before = write.path === canonical.ref.path ? canonical : await tx.get(db.doc(write.path));
      const absentFields: string[] = [];
      for (const field of [...Object.keys(write.patch), ...(write.deleteFields ?? [])]) {
        const previous = before.get(field);
        if (previous === undefined) absentFields.push(field);
        else write.expectedFields[field] = previous;
      }
      if (absentFields.length) write.absentFields = absentFields;
    }
    const requests = [
      { step, method, target, payload, fingerprint: publishingMutationRequestFingerprint({ method, target, payload }) },
    ];
    const verifications = [
      {
        provider: 'subsplash' as const,
        account: target.account,
        resourceType: target.resourceType === 'media' ? ('media' as const) : ('series' as const),
        resourceId: target.resourceId,
        expectedProviderFields: method === 'DELETE' ? {} : data,
        ...(method === 'DELETE' ? { expectedState: 'absent' as const } : {}),
      },
    ];
    // A separate bounded transaction below appends each immutable fragment. The
    // request stays unclaimable until every fragment is sealed by the final call.
    return { writes, requests, verifications };
  }).then(async (program) => {
    for (let offset = 0; offset < program.writes.length; offset += 64)
      await runDurableTransaction(db, async (tx) => {
        const prepared = await prepareAcknowledgedProjectionPlan(tx, {
          operation: operation!,
          completesActivity: false,
          finalFragment: false,
          requests: program.requests,
          writes: program.writes.slice(offset, offset + 64),
          verifications: program.verifications,
        });
        prepared.commit();
      });
    await runDurableTransaction(db, async (tx) => {
      const prepared = await prepareAcknowledgedProjectionPlan(tx, {
        operation: operation!,
        completesActivity: false,
        finalFragment: true,
        requests: program.requests,
        writes: [],
        verifications: [],
      });
      prepared.commit();
    });
  });
}
