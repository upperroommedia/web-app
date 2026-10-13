import type { DurableAdmissionReceipt } from '@upperroom/contracts/temporal';
import auth from '../firebase/auth';
import firebase, { isDevelopment } from '../firebase/firebase';
import { imageStorage, ref, uploadBytes, getMetadata } from '../firebase/storage';
import type { CroppedImageData } from './cropImage';
import { submitDurableIntent } from './durableJobs';

const PREFIX = 'urm:image-source:v1:';
const sessions = new Map<string, string>();
const hashBytes = async (blob: Blob): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
/** Byte transfer is browser-owned; processing and its results are server-owned. */
export async function ingestDurableImage(image: CroppedImageData, name: string): Promise<DurableAdmissionReceipt> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Please sign in before uploading an image.');
  const contentHash = await hashBytes(image.blob);
  const key = `${PREFIX}${firebase.options.projectId}:${isDevelopment ? 'emulator' : 'hosted'}:${uid}:${contentHash}:${
    image.type
  }:${name}`;
  const transfer = async () => {
    let requestId = sessions.get(key);
    try {
      requestId = localStorage.getItem(key) || requestId;
    } catch {
      /* Private mode keeps an in-tab session. */
    }
    requestId ||= crypto.randomUUID();
    sessions.set(key, requestId);
    try {
      localStorage.setItem(key, requestId);
    } catch {
      /* Backend idempotency is still enforced. */
    }
    const sourcePath = `durable-image-sources/${uid}/${requestId}/source`;
    const source = ref(imageStorage, sourcePath);
    let metadata;
    try {
      metadata = await getMetadata(source);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'storage/object-not-found')
        throw error;
      metadata = (
        await uploadBytes(source, image.blob, {
          contentType: image.contentType,
          customMetadata: { ownerUID: uid, durableRequestId: requestId, contentHash, name, type: image.type },
        })
      ).metadata;
    }
    if (
      metadata.customMetadata?.ownerUID !== uid ||
      metadata.customMetadata?.durableRequestId !== requestId ||
      metadata.customMetadata?.contentHash !== contentHash ||
      metadata.size !== image.blob.size
    ) {
      throw new Error(
        'The saved image source does not match this selection. Please contact an administrator; the original source has been kept.'
      );
    }
    const receipt = await submitDurableIntent({
      requestId,
      kind: 'image.ingest',
      entity: { type: 'image', id: requestId },
      payload: {
        name,
        type: image.type,
        sourcePath,
        sourceGeneration: metadata.generation,
        contentType: image.contentType,
      },
    });
    sessions.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      /* Optional persistence. */
    }
    return receipt;
  };
  return typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request(`image-transfer:${key}`, transfer)
    : transfer();
}

export function deleteDurableImage(imageId: string) {
  return submitDurableIntent({ kind: 'image.delete', entity: { type: 'image', id: imageId }, payload: {} });
}
