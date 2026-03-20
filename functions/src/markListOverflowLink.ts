import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRolePublish } from '@upperroom/shared/types/User';
import { OverflowBehavior, type List } from '@upperroom/shared/types/List';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import type {
  MarkListOverflowLinkInputType,
  MarkListOverflowLinkOutputType,
} from '../../packages/contracts/markListOverflowLink';
import { getFullListRows, patchListRows } from './helpers/addToListHelpers';
import {
  buildOverflowListMetadata,
  buildOverflowListTitle,
  getOverflowChainState,
  syncOverflowChainMetadata,
} from './helpers/listOverflowChain';
import handleError from './handleError';
import { withSubsplashLocks } from './locks/withSubsplashLocks';
import { subsplashSecretsWithRuntimeAlerts } from './subsplashSecrets';
import { authenticateSubsplash } from './subsplashUtils';

const firestore = firebaseAdmin.firestore();

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const getListRecordById = async (listId: string): Promise<{ id: string; data: List & { title?: string } }> => {
  const snapshot = await firestore.collection('lists').doc(listId).get();
  if (!snapshot.exists) {
    throw new HttpsError('not-found', `List ${listId} not found.`);
  }

  return {
    id: snapshot.id,
    data: snapshot.data() as List & { title?: string },
  };
};

const findListRecordBySubsplashId = async (
  subsplashId: string
): Promise<{ id: string; data: List & { title?: string } } | null> => {
  const snapshot = await firestore.collection('lists').where('subsplashId', '==', subsplashId).limit(2).get();
  if (snapshot.empty) {
    return null;
  }

  if (snapshot.docs.length > 1) {
    throw new HttpsError(
      'failed-precondition',
      `Multiple Firestore lists already exist for Subsplash list ${subsplashId}.`
    );
  }

  return {
    id: snapshot.docs[0].id,
    data: snapshot.docs[0].data() as List & { title?: string },
  };
};

const marklistoverflowlink = onCall(
  { secrets: subsplashSecretsWithRuntimeAlerts },
  async (request: CallableRequest<MarkListOverflowLinkInputType>): Promise<MarkListOverflowLinkOutputType> => {
    if (!canUserRolePublish(request.auth?.token.role)) {
      throw new HttpsError(
        'unauthenticated',
        'The function must be called while authenticated with publish permissions.'
      );
    }

    const rootListId = normalizeString(request.data?.rootListId);
    const physicalFirestoreListId = normalizeString(request.data?.physicalFirestoreListId);
    const rowId = normalizeString(request.data?.rowId);
    const clear = request.data?.clear === true;

    if (!rootListId || !physicalFirestoreListId || !rowId) {
      throw new HttpsError(
        'invalid-argument',
        'rootListId, physicalFirestoreListId, and rowId are required.'
      );
    }

    try {
      const chainState = await getOverflowChainState(rootListId);
      if (chainState.rootListId !== rootListId) {
        throw new HttpsError('failed-precondition', `List ${rootListId} is not the logical root.`);
      }

      const physicalNode = chainState.nodes.find((node) => node.firestoreListId === physicalFirestoreListId);
      if (!physicalNode) {
        throw new HttpsError(
          'failed-precondition',
          `List ${physicalFirestoreListId} is not part of the overflow chain for ${rootListId}.`
        );
      }

      const physicalSubsplashListId = normalizeString(physicalNode.subsplashId);
      if (!physicalSubsplashListId) {
        throw new HttpsError(
          'failed-precondition',
          `List ${physicalFirestoreListId} is not linked to Subsplash.`
        );
      }

      return await withSubsplashLocks([`list:${physicalSubsplashListId}`], async () => {
        const token = await authenticateSubsplash();
        const currentRows = await getFullListRows(physicalSubsplashListId, token);
        const currentRow = currentRows.find((row) => normalizeString(row.id) === rowId);
        if (!currentRow) {
          throw new HttpsError(
            'failed-precondition',
            `Row ${rowId} does not exist on Subsplash list ${physicalSubsplashListId}.`
          );
        }

        const physicalRecord = await getListRecordById(physicalFirestoreListId);
        const rootRecord = await getListRecordById(rootListId);

        if (clear) {
          await firestore.collection('lists').doc(physicalFirestoreListId).set(
            {
              moreSermonsRef: firebaseAdmin.firestore.FieldValue.delete(),
              manualOverflowRowId: firebaseAdmin.firestore.FieldValue.delete(),
              manualOverflowTargetSubsplashId: firebaseAdmin.firestore.FieldValue.delete(),
              updatedAtMillis: Date.now(),
            },
            { merge: true }
          );

          await syncOverflowChainMetadata(rootRecord.data.subsplashId!, token);

          return {
            status: 'success',
            rootListId,
            physicalFirestoreListId,
            cleared: true,
          };
        }

        if (currentRow.type !== 'list') {
          throw new HttpsError('failed-precondition', `Row ${rowId} is not a list row.`);
        }

        const linkedSubsplashListId = normalizeString(currentRow._embedded?.list?.id);
        const linkedListTitle =
          normalizeString(currentRow._embedded?.list?.title) ??
          normalizeString((currentRow._embedded?.list as { name?: string } | undefined)?.name);
        if (!linkedSubsplashListId) {
          throw new HttpsError(
            'failed-precondition',
            `List row ${rowId} does not expose a linked Subsplash list id.`
          );
        }

        const existingTargetSubsplashId = normalizeString(physicalRecord.data.moreSermonsRef);
        if (existingTargetSubsplashId && existingTargetSubsplashId !== linkedSubsplashListId) {
          throw new HttpsError(
            'failed-precondition',
            `List ${physicalFirestoreListId} already links to a different overflow page. Clear it first before selecting a new one.`
          );
        }

        const targetRecord = await findListRecordBySubsplashId(linkedSubsplashListId);
        if (targetRecord?.data.rootListId && targetRecord.data.rootListId !== rootListId) {
          throw new HttpsError(
            'failed-precondition',
            `Subsplash list ${linkedSubsplashListId} already belongs to a different logical root in Firestore.`
          );
        }

        const reorderedRows =
          currentRows[currentRows.length - 1]?.id === currentRow.id
            ? currentRows
            : [
                ...currentRows.filter((row) => row.id !== currentRow.id),
                currentRow,
              ];

        if (reorderedRows !== currentRows) {
          await patchListRows(physicalSubsplashListId, reorderedRows, token);
        }

        const now = Date.now();
        const batch = firestore.batch();
        batch.set(
          firestore.collection('lists').doc(physicalFirestoreListId),
          {
            moreSermonsRef: linkedSubsplashListId,
            manualOverflowRowId: rowId,
            manualOverflowTargetSubsplashId: linkedSubsplashListId,
            updatedAtMillis: now,
          },
          { merge: true }
        );

        let linkedFirestoreListId = targetRecord?.id;
        if (!targetRecord) {
          const newOverflowRef = firestore.collection('lists').doc();
          linkedFirestoreListId = newOverflowRef.id;
          batch.set(newOverflowRef, {
            id: newOverflowRef.id,
            name: buildOverflowListTitle(rootRecord.data.name || rootRecord.data.title || rootListId),
            title: linkedListTitle ?? buildOverflowListTitle(rootRecord.data.name || rootRecord.data.title || rootListId),
            subsplashId: linkedSubsplashListId,
            overflowBehavior: rootRecord.data.overflowBehavior ?? OverflowBehavior.CREATENEWLIST,
            count: 0,
            logicalCount: 0,
            hasOverflowPages: false,
            maxListSize: rootRecord.data.maxListSize ?? 200,
            images: [],
            type: rootRecord.data.type,
            createdAtMillis: now,
            updatedAtMillis: now,
            ...buildOverflowListMetadata({
              rootListId,
              overflowDepth: physicalNode.depth + 1,
            }),
          });
        }

        await batch.commit();

        if (!rootRecord.data.subsplashId) {
          throw new HttpsError('failed-precondition', `Root list ${rootListId} is not linked to Subsplash.`);
        }

        await syncOverflowChainMetadata(rootRecord.data.subsplashId, token);

        return {
          status: 'success',
          rootListId,
          physicalFirestoreListId,
          linkedSubsplashListId,
          linkedFirestoreListId,
          overflowDepth: physicalNode.depth + 1,
          cleared: false,
        };
      });
    } catch (error) {
      throw handleError(error);
    }
  }
);

export default marklistoverflowlink;
