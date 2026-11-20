import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
const fail = () => { throw new Error('EVENTARC_CREATE_AUDIT_UNCONFIRMED'); };
export function eventarcNativeOperation(value) {
  const name = normalize(value);
  if (!/^projects\/urm-app-staging\/locations\/us-central1\/operations\/[A-Za-z0-9_-]{1,200}$/.test(name ?? '')) fail();
  return name;
}
/** Recover only a causally acknowledged native operation from a complete FIRST
 * Data Access entry. No name lookup/adoption or inference from absent logs.
 * This supported envelope still requires actual native API acceptance proof.
 */
export async function recoverEventarcCreateAudit({ creation, creator, attemptedAt, api }) {
  const time = Date.parse(attemptedAt ?? '');
  if (!['outbox-trigger', 'commands-trigger'].includes(creation?.surface) || !Number.isFinite(time) || time > Date.now() + 1000 ||
    typeof creator !== 'string' || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(creator) || typeof api !== 'function') fail();
  const parent = 'projects/urm-app-staging/locations/us-central1', triggerId = creation.body.name.split('/').at(-1);
  const from = new Date(time - 60000).toISOString(), to = new Date(time + 600000).toISOString();
  const logName = 'projects/urm-app-staging/logs/cloudaudit.googleapis.com%2Fdata_access';
  const result = await api('https://logging.googleapis.com/v2/entries:list', 'POST', {
    resourceNames: ['projects/urm-app-staging'], pageSize: 100,
    filter: `logName=${JSON.stringify(logName)} AND protoPayload.serviceName="eventarc.googleapis.com" AND ` +
      'protoPayload.methodName="google.cloud.eventarc.v1.Eventarc.CreateTrigger" AND ' +
      `protoPayload.authenticationInfo.principalEmail=${JSON.stringify(creator)} AND ` +
      `timestamp >= ${JSON.stringify(from)} AND timestamp <= ${JSON.stringify(to)}`,
  });
  if (!result || result.nextPageToken || !Array.isArray(result.entries) || result.entries.length > 100) fail();
  const matches = result.entries.filter(entry => {
    const p = entry?.protoPayload, op = entry?.operation, stamp = Date.parse(entry?.timestamp ?? '');
    if (entry?.logName !== logName || typeof entry.insertId !== 'string' || !entry.insertId || !Number.isFinite(stamp) ||
      stamp < Date.parse(from) || stamp > Date.parse(to) || op?.first !== true || op.producer !== 'eventarc.googleapis.com' ||
      p?.serviceName !== 'eventarc.googleapis.com' || p.methodName !== 'google.cloud.eventarc.v1.Eventarc.CreateTrigger' ||
      p.authenticationInfo?.principalEmail !== creator ||
      p.authenticationInfo.serviceAccountDelegationInfo !== undefined && (!Array.isArray(p.authenticationInfo.serviceAccountDelegationInfo) || p.authenticationInfo.serviceAccountDelegationInfo.length !== 0) ||
      p.status?.code !== undefined && p.status.code !== 0 ||
      ![parent, creation.body.name].includes(normalize(p.resourceName)) || normalize(p.request?.parent) !== parent ||
      p.request?.triggerId !== triggerId || p.request?.validateOnly !== undefined && p.request.validateOnly !== false ||
      !isDeepStrictEqual(p.request?.trigger, creation.body) || p.response?.error ||
      p.response?.done !== undefined && ![false, true].includes(p.response.done)) return false;
    try { return eventarcNativeOperation(op.id) === eventarcNativeOperation(p.response?.name); } catch { return false; }
  });
  if (matches.length !== 1) fail();
  const entry = matches[0];
  return { nativeOperation: eventarcNativeOperation(entry.protoPayload.response.name),
    audit: { insertId: entry.insertId, timestamp: entry.timestamp, auditSHA256: proofDigest(entry),
      operationId: entry.operation.id, producer: entry.operation.producer,
      scope: 'exact supported FIRST Data Access actor/request/native operation response join; completion requires native operation GET' } };
}
