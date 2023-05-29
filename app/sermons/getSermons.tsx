import { cache } from 'react';
import { firestore } from 'firebase-admin';
import { firestoreAdminSermonConverter } from '../../functions/src/firestoreDataConverter';
import { uploadStatus } from '../../types/SermonTypes';

import 'server-only';

const getSermons = cache(async () => {
  try {
    return (
      await firestore()
        .collection('sermons')
        .withConverter(firestoreAdminSermonConverter)
        .where('status.subsplash', '==', uploadStatus.UPLOADED)
        .get()
    ).docs.map((doc) => doc.data());
  } catch (error) {
    return [];
  }
});

export default getSermons;
