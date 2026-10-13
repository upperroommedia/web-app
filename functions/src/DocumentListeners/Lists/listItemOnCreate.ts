import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import handleError from '../../handleError';
import { firestoreAdminListConverter } from '../../firestoreDataConverter';
import { shouldMirrorPhysicalListItemToRootMembership } from '../../helpers/listOverflowChain';

const listItemOnCreate = onDocumentCreated({ document: 'lists/{listId}/listItems/{sermonId}', retry: true }, async (event) => {
  const { listId, sermonId } = event.params;
  const firestore = firebaseAdmin.firestore();
  try {
    const listRef = firestore.collection('lists').doc(listId).withConverter(firestoreAdminListConverter);
    const sermonRef = firestore.doc(`sermons/${sermonId}`);
    const membershipRef = sermonRef.collection('sermonLists').doc(listId);
    await firestore.runTransaction(async (transaction) => {
      const listSnapshot = await transaction.get(listRef);
      const list = listSnapshot.data();
      if (!list) return;
      const rows = await transaction.get(listRef.collection('listItems').count());
      const row = await transaction.get(listRef.collection('listItems').doc(sermonId));
      const sermon = await transaction.get(sermonRef);
      const membership = await transaction.get(membershipRef);
      transaction.update(listRef, { count: rows.data().count });
      if (!row.exists || !sermon.exists || membership.exists || !shouldMirrorPhysicalListItemToRootMembership(list)) return;
      // Never reconstruct canonical membership from an old create event's payload.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { count: _count, updatedAtMillis: _updatedAtMillis, ...listData } = list;
      // Durable activities own canonical membership and can delete it before this projection.
      if (row.data()?._durableMembershipJobId) return;
      transaction.create(membershipRef, listData);
    });
  } catch (error) {
    throw handleError(error);
  }
});

export default listItemOnCreate;
