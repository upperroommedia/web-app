import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import type { DocumentData, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { isEqual } from 'lodash';
import { withProviderIndexedTransaction } from '@upperroom/orchestration/provider-transaction';
import { PROVIDER_USAGE_CONTROL } from '@upperroom/orchestration/provider-usage';
import { getFirebaseProjectId } from '@upperroom/shared/shared/firebaseProjectConfig';

// Leave room for reference edges and aggregate updates alongside mirror writes.
export const MIRROR_PAGE_SIZE = 40;

/** Reconcile each bounded page from canonical truth inside the same transaction as its writes. */
export async function reconcileCurrentCanonicalMirrors(
  db: Firestore,
  input: {
    sourcePath: string;
    collectionGroup: 'listItems' | 'sermonLists';
    id: string;
    parentCollection: 'lists' | 'sermons';
    project: (canonical: DocumentData, mirror: DocumentData) => DocumentData;
  }
): Promise<void> {
  let cursor: QueryDocumentSnapshot | undefined;
  while (true) {
    let query = db
      .collectionGroup(input.collectionGroup)
      .where('id', '==', input.id)
      .orderBy(FieldPath.documentId())
      .limit(MIRROR_PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await db.runTransaction(async (transaction) => {
      const usage = await transaction.get(db.doc(PROVIDER_USAGE_CONTROL));
      const reconcile = async (tx: typeof transaction) => {
        const canonical = await tx.get(db.doc(input.sourcePath));
        if (!canonical.exists) return undefined;
        const rows = await tx.get(query);
        // Read every parent before writing. Never recreate a projection under an absent parent.
        const parents = await Promise.all(rows.docs.map((row) => tx.get(row.ref.parent.parent!)));
        rows.docs.forEach((row, index) => {
          const parts = row.ref.path.split('/');
          if (
            parts.length !== 4 ||
            parts[0] !== input.parentCollection ||
            parts[2] !== input.collectionGroup ||
            !parents[index].exists
          )
            return;
          if (row.id !== input.id || row.get('id') !== input.id) return;
          const patch = input.project({ ...canonical.data(), id: canonical.id }, row.data());
          if (Object.entries(patch).some(([key, value]) => !isEqual(row.get(key), value))) tx.update(row.ref, patch);
        });
        return rows;
      };
      // Missing index is the pre-migration path. Once initialized, a mirror and
      // its provider references must commit together; building/reserved state
      // must fail closed rather than let a trigger bypass the usage barrier.
      return usage.exists
        ? withProviderIndexedTransaction(transaction, db, getFirebaseProjectId(), reconcile)
        : reconcile(transaction);
    });
    if (!page || page.size < MIRROR_PAGE_SIZE) return;
    cursor = page.docs.at(-1);
  }
}

/** Remove optional canonical fields without touching mirror-only placement/publication state. */
export function canonicalMirrorPatch(
  canonical: DocumentData,
  mirror: DocumentData,
  optionalFields: readonly string[]
): DocumentData {
  const patch = { ...canonical };
  for (const key of optionalFields) {
    if (Object.prototype.hasOwnProperty.call(mirror, key) && !Object.prototype.hasOwnProperty.call(canonical, key))
      patch[key] = FieldValue.delete();
  }
  return patch;
}
