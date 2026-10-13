import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { withLegacyAdmissionLease } from '../legacyAdmissionLease';
import type { Request, Response } from 'express';

/** Historical maintenance HTTP endpoints cannot bypass the private release owner or authentication. */
export async function guardLegacyPublishingHttpMutation(
  req: Pick<Request, 'method' | 'headers'>,
  res: Pick<Response, 'status' | 'json'>,
  operation: () => Promise<unknown> = async () => undefined
): Promise<boolean> {
  let actorUid = '';
  let admitted = false;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Maintenance mutations require an authenticated POST request.' });
    return false;
  }
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Administrator authentication is required.' });
    return false;
  }
  try {
    const token = await firebaseAdmin.auth().verifyIdToken(authorization.slice(7), true);
    const actor = await firebaseAdmin.auth().getUser(token.uid);
    actorUid = token.uid;
    if (actor.disabled || actor.customClaims?.role !== 'admin') {
      res.status(403).json({ error: 'Administrator permission is required.' });
      return false;
    }
  } catch {
    res.status(401).json({ error: 'Administrator authentication is required.' });
    return false;
  }
  try {
    await withLegacyAdmissionLease(
      firebaseAdmin.firestore(),
      {
        domain: 'publishing',
        actorUid,
        operation: 'legacy-http-maintenance',
        projectId: firebaseAdmin.app().options.projectId || '',
      },
      async (lease) => {
        admitted = true;
        await lease.markEffectsStarted();
        return operation();
      }
    );
  } catch (error) {
    if (admitted) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    res.status(code === 'unavailable' ? 503 : 409).json({
      error: 'Maintenance admission is paused or has moved to durable tasks. Refresh the application before retrying.',
    });
    return false;
  }
  return true;
}
