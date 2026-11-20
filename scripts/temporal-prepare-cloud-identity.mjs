import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
import { preparationIdentityEmail } from './temporal-preparation-resources.mjs';

const fail = () => { throw new Error('CLOUD_RUN_IDENTITY_PREPARATION_UNCONFIRMED'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function identityPlan({ platform, role, kind, operationId, creator, evidenceDigest }) {
  validateCloudRunReleasePlatform(platform);
  if (!uuid.test(operationId ?? '') ||
    typeof creator !== 'string' || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(creator) ||
    !/^[a-f0-9]{64}$/.test(evidenceDigest ?? '')) fail();
  const email = preparationIdentityEmail(platform, role, kind);
  const accountId = email.split('@')[0];
  const marker = digest({ operationId, build: platform.workerBuildId, image: platform.workerImage, role, kind, evidenceDigest });
  return { schemaVersion: 1, operationId, creator, buildId: platform.workerBuildId, role, kind, email, evidenceDigest,
    resource: `projects/urm-app-staging/serviceAccounts/${email}`,
    request: { accountId, serviceAccount: {
      displayName: `Temporal staging ${role} ${kind}`,
      description: `urm-preparation:${operationId}:${marker}`,
    } } };
}
function nativeAccount(plan, value) {
  if (!value || value.projectId !== 'urm-app-staging' || value.email !== plan.email || value.disabled === true ||
    !/^[0-9]{10,30}$/.test(value.uniqueId ?? '') || value.description !== plan.request.serviceAccount.description ||
    value.displayName !== plan.request.serviceAccount.displayName) fail();
  return { email: value.email, uniqueId: value.uniqueId, description: value.description, displayName: value.displayName };
}

/** Recover a lost account-create acknowledgement only from an exact native audit
 * request/actor/response join plus the current unique ID. Name/marker alone is insufficient.
 */
async function creationAudit(plan, attempt, current, api) {
  const from = new Date(Date.parse(attempt.attemptedAt) - 60000).toISOString();
  const to = new Date(Date.parse(attempt.attemptedAt) + 24 * 60 * 60 * 1000).toISOString();
  const response = await api('https://logging.googleapis.com/v2/entries:list', 'POST', {
    resourceNames: ['projects/urm-app-staging'], pageSize: 100,
    filter: `logName="projects/urm-app-staging/logs/cloudaudit.googleapis.com%2Factivity" AND ` +
      `protoPayload.methodName="google.iam.admin.v1.CreateServiceAccount" AND ` +
      `protoPayload.authenticationInfo.principalEmail=${JSON.stringify(plan.creator)} AND ` +
      `timestamp >= ${JSON.stringify(from)} AND timestamp <= ${JSON.stringify(to)}`,
  });
  if (response.nextPageToken || !Array.isArray(response.entries)) fail();
  const matches = response.entries.filter(entry => {
    const payload = entry.protoPayload;
    return entry.insertId && Number.isFinite(Date.parse(entry.timestamp)) &&
      Date.parse(entry.timestamp) >= Date.parse(from) && Date.parse(entry.timestamp) <= Date.parse(to) &&
      payload?.serviceName === 'iam.googleapis.com' && payload.methodName === 'google.iam.admin.v1.CreateServiceAccount' &&
      payload.authenticationInfo?.principalEmail === plan.creator && (!payload.status?.code || payload.status.code === 0) &&
      payload.request?.accountId === plan.request.accountId &&
      isDeepStrictEqual(payload.request?.serviceAccount, plan.request.serviceAccount) &&
      payload.response?.email === plan.email && payload.response?.uniqueId === current.uniqueId;
  });
  if (matches.length !== 1) fail();
  return { insertId: matches[0].insertId, timestamp: matches[0].timestamp, auditSHA256: digest(matches[0]) };
}

/** Connected account-only preparation. It creates no key, grant, pool, worker,
 * compute association, dispatch wake or phase transition. Save callbacks are the
 * release operator's snapshot-fenced transactions, not caller-supplied descriptor code.
 */
export async function prepareCloudRunIdentity(options) {
  const { api, saved, save } = options;
  const plan = identityPlan(options);
  if (typeof api !== 'function' || typeof save !== 'function') fail();
  let state = saved;
  try {
    if (state !== undefined && (!state || !isDeepStrictEqual(state.plan, plan) ||
      !['planned', 'attempted', 'acknowledged', 'completed', 'rejected'].includes(state.stage))) fail();
    if (state === undefined) {
      state = { plan, stage: 'planned' };
      await save(state); // An unknown transaction acknowledgement cannot reach HTTP.
    }
    const read = async () => {
      try { return await api(`https://iam.googleapis.com/v1/${plan.resource}`); }
      catch (error) { if (error?.status === 404) return null; throw error; }
    };
    if (state.stage === 'planned') {
      if (await read()) fail(); // Never adopt a pre-existing similarly named identity.
      state = { plan, stage: 'attempted', attemptedAt: new Date().toISOString() };
      await save(state);
      let response;
      try {
        response = await api('https://iam.googleapis.com/v1/projects/urm-app-staging/serviceAccounts', 'POST', plan.request);
      } catch (error) {
        if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          await save({ ...state, stage: 'rejected', status: error.status });
          return fail();
        }
        // Transport-unknown remains attempted. GET/audit only from this point.
      }
      if (response) {
        const account = nativeAccount(plan, response);
        state = { ...state, stage: 'acknowledged', account };
        await save(state); // Do not proceed if acknowledgement persistence is unknown.
      }
    }
    if (state.stage === 'rejected') fail();
    if (!Number.isFinite(Date.parse(state.attemptedAt ?? ''))) fail();
    const current = nativeAccount(plan, await read());
    if (state.stage === 'attempted') {
      const audit = await creationAudit(plan, state, current, api);
      state = { ...state, stage: 'acknowledged', account: current, audit };
      await save(state);
    }
    if (!isDeepStrictEqual(state.account, current)) fail();
    if (state.stage !== 'completed') {
      state = { ...state, stage: 'completed', verifiedAt: new Date().toISOString() };
      await save(state);
    }
    return { schemaVersion: 1, operationId: plan.operationId, role: plan.role, kind: plan.kind,
      account: current, requestSHA256: digest(plan.request), evidenceDigest: plan.evidenceDigest,
      verifiedAt: state.verifiedAt, scope: 'dedicated identity creation only; no keys, permissions or compute activation' };
  } catch { return fail(); }
}
