import type { DeleteFromSubsplashInputType, DeleteFromSubsplashReturnType } from '@upperroom/contracts/deleteFromSubsplash';
import firestore, {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  increment,
  updateDoc,
  writeBatch,
} from '../firebase/firestore';
import { sermonConverter } from '../types/Sermon';
import { sermonListConverter } from '../types/SermonList';
import { uploadStatus } from '../types/SermonTypes';
import { createFunctionV2 } from './createFunction';
import { createSubsplashDeleteIntentKey } from './subsplashPublishFlow';

interface DeleteSubsplashMediaAndLocalStateInput {
  sermonId: string;
  subsplashId?: string;
  seriesId?: string;
}

export async function deleteSubsplashMediaAndLocalState({
  sermonId,
  subsplashId,
  seriesId,
}: DeleteSubsplashMediaAndLocalStateInput): Promise<boolean> {
  const normalizedSubsplashId = subsplashId?.trim();
  if (!normalizedSubsplashId) {
    return false;
  }

  const deleteFromSubsplash = createFunctionV2<DeleteFromSubsplashInputType, DeleteFromSubsplashReturnType>('deletefromsubsplash');
  await deleteFromSubsplash({
    subsplashId: normalizedSubsplashId,
    operationKey: createSubsplashDeleteIntentKey('manage-publishing-delete', sermonId),
  });

  const sermonListsSnapshot = await getDocs(
    collection(firestore, `sermons/${sermonId}/sermonLists`).withConverter(sermonListConverter)
  );
  const seriesItemRef = seriesId ? doc(firestore, `series/${seriesId}/seriesItems`, sermonId) : null;
  const seriesItemSnapshot = seriesItemRef ? await getDoc(seriesItemRef) : null;
  const batch = writeBatch(firestore);

  sermonListsSnapshot.docs.forEach((sermonListDoc) => {
    const listDocRef = doc(firestore, 'lists', sermonListDoc.id, 'listItems', sermonId);

    batch.set(
      sermonListDoc.ref,
      {
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
        publishGeneration: increment(1),
      },
      { merge: true }
    );
    batch.set(
      listDocRef,
      {
        subsplashId: deleteField(),
        uploadStatus: { status: uploadStatus.NOT_UPLOADED },
        physicalPlacement: deleteField(),
      },
      { merge: true }
    );
  });

  if (seriesItemRef && seriesItemSnapshot?.exists()) {
    batch.set(
      seriesItemRef,
      {
        publishedToSubsplash: false,
        sermonSubsplashId: deleteField(),
      },
      { merge: true }
    );
  }

  await batch.commit();

  await updateDoc(doc(firestore, 'sermons', sermonId).withConverter(sermonConverter), {
    subsplashId: deleteField(),
    numberOfListsUploadedTo: 0,
    subsplashUploadGeneration: increment(1),
    'status.subsplash': uploadStatus.NOT_UPLOADED,
  });

  return true;
}
