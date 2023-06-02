import { firestore } from 'firebase-functions';
import firebaseAdmin from '../../../../firebase/firebaseAdmin';
import handleError from '../../handleError';

const sermonOnDelete = firestore.document('sermons/{sermonId}').onDelete(async (_snapshot, context) => {
  const { sermonId } = context.params;
  const firestore = firebaseAdmin.firestore();
  try {
    await firestore.recursiveDelete(firestore.doc(`sermons/${sermonId}`));
    // Define a list of folder names where the file may exist
    const folderNames = ['sermons', 'processed-sermons', 'intro-outro-sermons'];

    // Delete the file from each folder asynchronously
    Promise.all(
      folderNames.map(async (folderName) => {
        // Get a reference to the file in the current folder
        const fileRef = firebaseAdmin.storage().bucket().file(`${folderName}/${sermonId}`);

        // Check if the file exists
        const [exists] = await fileRef.exists();

        // Delete the file if it exists
        if (exists) {
          await fileRef.delete();
          console.log(`File ${sermonId} deleted from ${folderName}`);
        }
      })
    );
  } catch (error) {
    throw handleError(error);
  }
});

export default sermonOnDelete;
