import { DocumentSnapshot } from 'firebase-admin/firestore';

/** Serialize each document's writes, resolve the current state rather than replaying an old
 * event, and confirm that the source stayed unchanged while Algolia processed the write. */
export async function converge(
  read: () => Promise<DocumentSnapshot>,
  write: (snapshot: DocumentSnapshot) => Promise<void>,
  attempts = 6,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await read();
    await write(snapshot);
    const current = await read();
    if (snapshot.exists === current.exists && (!snapshot.exists || snapshot.updateTime?.isEqual(current.updateTime!))) return;
  }
  throw new Error('Document kept changing during Algolia sync; retry required');
}
