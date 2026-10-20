import { randomUUID, createHash } from 'node:crypto';
import { serverlessResourceNames } from '../../temporal-serverless-platform.mjs';
import { dispatchResourceNames } from '../../temporal-serverless-dispatch-resources.mjs';
import { renderServerlessWorkerPool } from '../../temporal-serverless-resources.mjs';
import { temporalCloudScalerPrincipals } from '../../temporal-release-cloud-run.mjs';
import { runtimeRolePreparationPlan } from '../../temporal-prepare-runtime-role.mjs';
import { proofDigest } from '../../temporal-release-runtime.mjs';
/** Controlled Cloud/creation receipts only; never native attestation. */
export function controlsBootstrapFixture(role='controls') {
  const buildId = 'a'.repeat(40),
    image = `us-central1-docker.pkg.dev/urm-app-staging/urm-temporal/worker@sha256:${'b'.repeat(64)}`,
    workerRoles = ['orchestration', 'controls'];
  const platform = {
    schemaVersion: 1,
    environment: 'staging',
    workerHosting: 'cloud-run',
    connectionMode: 'temporal-cloud',
    firebaseProjectId: 'urm-app-staging',
    firebaseResources: {
      storageBucket: 'urm-app-staging.firebasestorage.app',
      imagesBucket: 'urm-app-staging-images',
      databaseUrl: 'https://urm-app-staging-default-rtdb.firebaseio.com/',
    },
    temporalNamespace: 'urm-app-staging.qwejt',
    cloudAccountId: 'qwejt',
    cloudProvider: 'gcp',
    cloudRegion: 'us-central1',
    cloudAddress: 'us-central1.gcp.api.temporal.io:7233',
    cloudReplicaRegions: [],
    cloudEvidence: '/private/tmp/native-namespace',
    workerBuildId: buildId,
    workerImage: image,
    workerRoles,
    dispatcherEnabled: false,
    operatorApiKeyFile: '/private/tmp/operator-key',
    operatorApiKeySHA256: 'c'.repeat(64),
    dispatch: { ...dispatchResourceNames(buildId), apiKeyVersion: '2' },
    roleBindings: workerRoles.map((role) => ({
      projectId: 'urm-app-staging',
      region: 'us-central1',
      namespace: 'urm-app-staging.qwejt',
      buildId,
      role,
      ...serverlessResourceNames(buildId, role),
      image,
      maxInstances: 1,
      stabilizationSeconds: 180,
    })),
  };
  const b = platform.roleBindings.find(b=>b.role===role),
    releaseId = randomUUID(),
    operationId = randomUUID(),
    evidenceDigest = 'c'.repeat(64),
    settings = { apiKeyVersion: '2', runtimeSecrets: role==='orchestration'?['RUNTIME_ALERT_RECIPIENTS','ADMIN_BASE_URL'].map(name=>({name,secret:name,version:'2'})):[] };
  const receipts = {},
    policies = new Map(),
    roles = new Map(),
    calls = [],
    states = [];
  const receipt = (plan, extra = {}) =>
    structuredClone({
      operationId: plan.operationId,
      releaseId,
      identityState: { plan, stage: 'completed', ...extra },
    });
  for (const [kind, email, uniqueId] of [
    ['runner', b.runnerServiceAccount, '11111111111111111111'],
    ['scaler', b.invokerServiceAccount, '22222222222222222222'],
  ]) {
    const plan = { operationId: randomUUID(), releaseId, evidenceDigest, kind, email, role, buildId };
    receipts[kind] = receipt(plan, { account: { email, uniqueId, description: `owned-${kind}` } });
  }
  const body = renderServerlessWorkerPool(b, settings),
    poolId = randomUUID();
  body.annotations = { 'urm.upperroom.media/preparation': poolId };
  const original = {
    name: body.name,
    uid: 'native-pool',
    generation: '1',
    revision: `${body.name}/revisions/original`,
    desiredManualInstanceCount: 0,
  };
  receipts.pool = receipt(
    {
      schemaVersion: 1,
      operationId: poolId,
      releaseId,
      evidenceDigest,
      role,
      buildId,
      runner: b.runnerServiceAccount,
      identityReceiptSHA256: createHash('sha256').update(JSON.stringify(receipts.runner)).digest('hex'),
      body,
    },
    { pool: original, prerequisites: { runnerUniqueId: receipts.runner.identityState.account.uniqueId } }
  );
  const account = (email) => `projects/urm-app-staging/serviceAccounts/${email}`,
    runner = `serviceAccount:${b.runnerServiceAccount}`,
    scaler = `serviceAccount:${b.invokerServiceAccount}`;
  for (const [key, surface, resource, grants] of [
    [
      'runnerScaler',
      'runner-scaler-user',
      account(b.runnerServiceAccount),
      [{ role: 'roles/iam.serviceAccountUser', members: [scaler] }],
    ],
    [
      'scalerTrust',
      'scaler-trust',
      account(b.invokerServiceAccount),
      [{ role: 'roles/iam.serviceAccountTokenCreator', members: [...temporalCloudScalerPrincipals] }],
    ],
    [
      'poolAccess',
      'pool-access',
      body.name,
      [
        { role: 'roles/run.viewer', members: [runner] },
        { role: 'roles/run.developer', members: [scaler] },
      ],
    ],
  ]) {
    receipts[key] = receipt(
      {
        schemaVersion: 1,
        operationId: randomUUID(),
        releaseId,
        evidenceDigest,
        role,
        surface,
        buildId,
        runner: b.runnerServiceAccount,
        scaler: b.invokerServiceAccount,
        resource,
        grants,
        settingsSHA256: proofDigest(settings),
        runnerReceiptSHA256: proofDigest(receipts.runner),
        scalerReceiptSHA256: proofDigest(receipts.scaler),
        poolReceiptSHA256: proofDigest(receipts.pool),
      },
      {
        prerequisites: {
          runnerUniqueId: receipts.runner.identityState.account.uniqueId,
          scalerUniqueId: receipts.scaler.identityState.account.uniqueId,
        },
      }
    );
    policies.set(resource, { version: 1, etag: 'native-policy', bindings: grants });
  }
  const database = {
    name: 'projects/urm-app-staging/databases/(default)',
    uid: 'native-db',
    type: 'FIRESTORE_NATIVE',
    locationId: 'us-central1',
  };
  const firestoreGrant = {
    role: 'roles/datastore.user',
    members: [runner],
    condition: { title: 'urm-temporal-default-firestore', expression: `resource.name=="${database.name}"` },
  };
  receipts.firestore = receipt(
    {
      schemaVersion: 1,
      operationId: randomUUID(),
      releaseId,
      evidenceDigest,
      role,
      buildId,
      runner: b.runnerServiceAccount,
      resource: 'projects/urm-app-staging',
      database: database.name,
      workload: { type: 'worker-pool', name: body.name },
      settingsSHA256: proofDigest(settings),
      identityReceiptSHA256: proofDigest(receipts.runner),
      grants: [firestoreGrant],
    },
    { prerequisites: { runnerUniqueId: receipts.runner.identityState.account.uniqueId, database } }
  );
  const bucket = {
      name: platform.firebaseResources.storageBucket,
      id: platform.firebaseResources.storageBucket,
      projectNumber: '251680231116',
      timeCreated: '2026-01-01T00:00:00Z',
    },
    projectGrants = [firestoreGrant];
  for (const surface of ['project', 'storage']) {
    const plan = runtimeRolePreparationPlan({
      platform,
      role,
      surface,
      settings,
      operationId: randomUUID(),
      releaseId,
      evidenceDigest,
      identityReceipt: receipts.runner,
    });
    const nativeRole = {
      ...plan.request.role,
      name: `projects/urm-app-staging/roles/${plan.request.roleId}`,
      etag: 'native-role',
    };
    roles.set(nativeRole.name, nativeRole);
    receipts[`${surface}Role`] = receipt(plan, {
      prerequisites: { runnerUniqueId: receipts.runner.identityState.account.uniqueId },
      nativeRole,
    });
    const resource = surface === 'project' ? 'projects/urm-app-staging' : `projects/_/buckets/${bucket.name}`,
      grants = [{ role: nativeRole.name, members: [runner] }];
    receipts[`${surface}Access`] = receipt(
      {
        schemaVersion: 1,
        operationId: randomUUID(),
        releaseId,
        evidenceDigest,
        role,
        surface,
        buildId,
        runner: b.runnerServiceAccount,
        pool: body.name,
        resource,
        settingsSHA256: proofDigest(settings),
        identityReceiptSHA256: proofDigest(receipts.runner),
        roleReceiptSHA256: proofDigest(receipts[`${surface}Role`]),
        grants,
      },
      {
        prerequisites: {
          runnerUniqueId: receipts.runner.identityState.account.uniqueId,
          resourceIdentity:
            surface === 'storage' ? bucket : { projectId: 'urm-app-staging', projectNumber: '251680231116' },
        },
      }
    );
    if (surface === 'project') projectGrants.push(...grants);
    else
      policies.set(resource, {
        kind: 'storage#policy',
        resourceId: resource,
        etag: 'native-storage',
        version: 1,
        bindings: grants,
      });
  }
  policies.set('projects/urm-app-staging', { version: 3, etag: 'native-project', bindings: projectGrants });
  let saved,
    pool = {
      ...structuredClone(body),
      uid: original.uid,
      generation: '1',
      observedGeneration: '1',
      etag: 'pool-1',
      terminalCondition: { state: 'CONDITION_SUCCEEDED' },
      latestCreatedRevision: original.revision,
      latestReadyRevision: original.revision,
    };
  const operations = new Map();
  const options = {
    platform,
    role,
    settings,
    operationId,
    releaseId,
    evidenceDigest,
    receipts,
    save: async (next) => {
      saved = structuredClone(next);
      states.push(saved);
    },
    observeProtection: async () => ({
      namespace: platform.temporalNamespace,
      role,
      buildId,
      observedAt: new Date().toISOString(),
      protectionSHA256: 'd'.repeat(64),
      computeInventorySHA256: 'e'.repeat(64),
    }),
    observeRegistration: async () => ({
      role,
      buildId,
      observedAt: new Date().toISOString(),
      registrationSHA256: 'f'.repeat(64),
    }),
    api: async (url, method = 'GET', request, beforeSend) => {
      if(beforeSend)await beforeSend();
      calls.push({ url, method, request: structuredClone(request) });
      if (method === 'PATCH') {
        if (
          saved?.[request.scaling.manualInstanceCount === 1 ? 'start' : 'stop']?.stage !== 'attempted' ||
          request.etag !== pool.etag
        )
          throw new Error('unsafe patch');
        const gen = String(Number(pool.generation) + 1);
        pool = {
          ...pool,
          scaling: { manualInstanceCount: request.scaling.manualInstanceCount },
          generation: gen,
          observedGeneration: gen,
          etag: `pool-${gen}`,
        };
        const name = `projects/urm-app-staging/locations/us-central1/operations/op-${gen}`;
        operations.set(name, { name, done: true, response: structuredClone(pool) });
        return { name };
      }
      if (url.includes('/operations/')) return structuredClone(operations.get(url.split('/v2/')[1]));
      if (url.includes('getIamPolicy')) {
        let resource = url.replace(/^https:\/\/[^/]+\/v[12]\//, '').split(':getIamPolicy')[0];
        if (url.includes('/b/')) resource = `projects/_/buckets/${bucket.name}`;
        return structuredClone(policies.get(resource));
      }
      if (url.includes('/b/') && url.includes('/iam?'))
        return structuredClone(policies.get(`projects/_/buckets/${bucket.name}`));
      if (url.includes('secretmanager'))
        return url.includes('getIamPolicy')
          ? { etag: 'key', bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [runner] }] }
          : { name:url.split('/v1/')[1], state: 'ENABLED' };
      if (url.includes('/serviceAccounts/')) {
        const r = url.includes(b.runnerServiceAccount) ? receipts.runner : receipts.scaler;
        return { ...r.identityState.account, projectId: 'urm-app-staging' };
      }
      if (url.includes('/roles/')) return structuredClone(roles.get(url.split('/v1/')[1]));
      if (url.includes('firestore.googleapis.com')) return structuredClone(database);
      if (url.includes('storage.googleapis.com')) return structuredClone(bucket);
      if (url === `https://run.googleapis.com/v2/${body.name}`) return structuredClone(pool);
      throw new Error('unexpected controlled API');
    },
  };
  // Secret IAM is a separate API, not the project/service policy envelope.
  const api = options.api;
  options.api = async (...args) =>
    args[0].includes('secretmanager') && args[0].includes('getIamPolicy')
      ? { etag: 'key', bindings: [{ role: 'roles/secretmanager.secretAccessor', members: [runner] }] }
      : api(...args);
  return {
    options,
    calls,
    states,
    policies,
    roles,
    database,
    bucket,
    get saved() {
      return saved;
    },
    get pool() {
      return pool;
    },
    set pool(v) {
      pool = v;
    },
  };
}
