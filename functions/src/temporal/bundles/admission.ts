import { createHash } from 'node:crypto';
import type { DurableAdmissionRequest } from '@upperroom/contracts/temporal';
import { HttpsError } from 'firebase-functions/v2/https';
import { getDurableBundleConfig } from './activities';
import { submitServerDurableJob } from '../bridge';

export function normalizeBundleAdmission(request: DurableAdmissionRequest): { bundleType: string } {
  const bundleType = request.payload.bundleType;
  if (request.kind !== 'bundle.regenerate' || typeof bundleType !== 'string')
    throw new HttpsError('invalid-argument', 'Valid bundle type required.');
  getDurableBundleConfig(bundleType);
  return { bundleType };
}
/** Event IDs identify delivery retries; changes coalesce inside one coordinator. */
export async function admitBundleRegeneration(
  bundleType: string,
  eventId: string,
  options: { continuation?: boolean } = {}
): Promise<void> {
  getDurableBundleConfig(bundleType);
  await submitServerDurableJob({
    continuation: options.continuation === true,
    kind: 'bundle.regenerate',
    entity: { type: 'bundle', id: bundleType },
    actorUid: 'system:firebase-event',
    requestId: `bundle-${createHash('sha256').update(`${bundleType}:${eventId}`).digest('hex')}`,
    payload: { bundleType },
  });
}
