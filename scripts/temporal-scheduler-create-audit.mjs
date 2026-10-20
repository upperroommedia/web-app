import { isDeepStrictEqual } from 'node:util';
import { proofDigest } from './temporal-release-runtime.mjs';
import { dispatchWakeIdentity } from './temporal-stop-dispatch-wake.mjs';
import { normalizeStagingResourceName as normalize } from './temporal-preparation-resources.mjs';
const fail = () => { throw new Error('SCHEDULER_CREATE_AUDIT_UNCONFIRMED'); };
const parent = 'projects/urm-app-staging/locations/us-central1';
/** A strict supported envelope, not an assertion that every native log retains
 * these fields. Missing/redacted/paginated/ambiguous records remain unresolved.
 */
export async function reconcileSchedulerCreateAudit({ creation, creator, attemptedAt, current, api }) {
  const time = Date.parse(attemptedAt ?? '');
  if (creation?.surface !== 'scheduler' || !Number.isFinite(time) || time > Date.now() + 1000 ||
    typeof creator !== 'string' || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(creator) || typeof api !== 'function') fail();
  const resource = dispatchWakeIdentity(creation, current);
  const from = new Date(time - 60000).toISOString(), to = new Date(time + 600000).toISOString();
  const createdAt = Date.parse(resource.userUpdateTime);
  if (createdAt < Date.parse(from) || createdAt > Date.parse(to)) fail();
  const response = await api('https://logging.googleapis.com/v2/entries:list', 'POST', {
    resourceNames: ['projects/urm-app-staging'], pageSize: 100,
    filter: 'logName="projects/urm-app-staging/logs/cloudaudit.googleapis.com%2Factivity" AND ' +
      'protoPayload.serviceName="cloudscheduler.googleapis.com" AND ' +
      'protoPayload.methodName="google.cloud.scheduler.v1.CloudScheduler.CreateJob" AND ' +
      `protoPayload.authenticationInfo.principalEmail=${JSON.stringify(creator)} AND ` +
      `timestamp >= ${JSON.stringify(from)} AND timestamp <= ${JSON.stringify(to)}`,
  });
  if (!response || response.nextPageToken || !Array.isArray(response.entries) || response.entries.length > 100) fail();
  const matches = response.entries.filter(entry => {
    const p = entry?.protoPayload, stamp = Date.parse(entry?.timestamp ?? '');
    if (typeof entry?.insertId !== 'string' || !entry.insertId || !Number.isFinite(stamp) ||
      stamp < Date.parse(from) || stamp > Date.parse(to) || entry.logName !== 'projects/urm-app-staging/logs/cloudaudit.googleapis.com%2Factivity' ||
      p?.serviceName !== 'cloudscheduler.googleapis.com' || p.methodName !== 'google.cloud.scheduler.v1.CloudScheduler.CreateJob' ||
      p.authenticationInfo?.principalEmail !== creator || (p.authenticationInfo.serviceAccountDelegationInfo?.length ?? 0) !== 0 ||
      (p.status?.code !== undefined && p.status.code !== 0) ||
      ![parent, creation.body.name].includes(normalize(p.resourceName)) || normalize(p.request?.parent) !== parent ||
      !isDeepStrictEqual(p.request?.job, creation.body)) return false;
    try { return isDeepStrictEqual(dispatchWakeIdentity(creation, p.response), resource); } catch { return false; }
  });
  if (matches.length !== 1) fail();
  return { resource, audit: { insertId: matches[0].insertId, timestamp: matches[0].timestamp,
    auditSHA256: proofDigest(matches[0]), scope: 'exact supported native actor/request/response/current identity join' } };
}
