import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { firestoreAdminSermonConverter } from '../firestoreDataConverter';
import { recalculateSermonCounts } from './recalculateSermonCounts';

type InvariantReason =
  | 'numberOfLists-negative'
  | 'numberOfListsUploadedTo-negative'
  | 'numberOfListsUploadedTo-greater-than-numberOfLists';

export interface SermonCountInvariantResult {
  repaired: boolean;
  reason?: InvariantReason;
  before: {
    numberOfLists: number;
    numberOfListsUploadedTo: number;
  };
  after: {
    numberOfLists: number;
    numberOfListsUploadedTo: number;
  };
}

function getInvariantReason(numberOfLists: number, numberOfListsUploadedTo: number): InvariantReason | undefined {
  if (numberOfLists < 0) {
    return 'numberOfLists-negative';
  }
  if (numberOfListsUploadedTo < 0) {
    return 'numberOfListsUploadedTo-negative';
  }
  if (numberOfListsUploadedTo > numberOfLists) {
    return 'numberOfListsUploadedTo-greater-than-numberOfLists';
  }
  return undefined;
}

export async function ensureSermonCountInvariant(sermonId: string): Promise<SermonCountInvariantResult> {
  const firestoreDb = firebaseAdmin.firestore();
  const sermonRef = firestoreDb.doc(`sermons/${sermonId}`).withConverter(firestoreAdminSermonConverter);
  const sermonSnapshot = await sermonRef.get();

  if (!sermonSnapshot.exists) {
    const zeroCounters = {
      numberOfLists: 0,
      numberOfListsUploadedTo: 0,
    };
    return {
      repaired: false,
      before: zeroCounters,
      after: zeroCounters,
    };
  }

  const sermon = sermonSnapshot.data()!;
  const before = {
    numberOfLists: sermon.numberOfLists ?? 0,
    numberOfListsUploadedTo: sermon.numberOfListsUploadedTo ?? 0,
  };
  const reason = getInvariantReason(before.numberOfLists, before.numberOfListsUploadedTo);

  if (!reason) {
    return {
      repaired: false,
      before,
      after: before,
    };
  }

  const recalculated = await recalculateSermonCounts(sermonId, before.numberOfLists, before.numberOfListsUploadedTo);
  const result = {
    repaired: recalculated.wasInconsistent,
    reason,
    before,
    after: recalculated.after,
  };

  console.warn('sermonCountInvariantGuard.repaired', {
    sermonId,
    reason,
    before,
    after: recalculated.after,
  });

  return result;
}
