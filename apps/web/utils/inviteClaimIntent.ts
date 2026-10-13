/** Persist only an opaque identity. An invitation token must never enter browser storage. */
export async function getInviteClaimRequestId(uid: string, token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `urm:invite-claim:v1:${getFirebaseProjectId()}:${
    process.env.NODE_ENV === 'development' ? 'emulator' : 'hosted'
  }:${uid}:${fingerprint}`;
  try {
    const previous = sessionStorage.getItem(key);
    if (previous) return previous;
  } catch {
    /* A stable digest still identifies the same claim when storage is disabled. */
  }
  const requestId = `invite-claim-${fingerprint}`;
  try {
    sessionStorage.setItem(key, requestId);
  } catch {
    /* Backend admission remains idempotent. */
  }
  return requestId;
}
import { getFirebaseProjectId } from '../shared/firebaseProjectConfig';
