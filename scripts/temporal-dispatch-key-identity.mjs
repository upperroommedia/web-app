import { createHash } from 'node:crypto';
import { crc32c } from './temporal-vm-secrets.mjs';
const endpoint = 'https://saas-api.tmprl.cloud/cloud/current-identity';
const ownerId = '535f014e60bc401ba205eed01a35d164';
const only = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => fields.includes(key));
const fail = () => { throw new Error('DISPATCH_TEMPORAL_KEY_IDENTITY_UNCONFIRMED'); };
/** Read-only operator witness for the exact numeric shared worker key. No key
 * issuance, rotation, secret creation, privilege change or runtime attestation.
 * No key, auth header, raw provider error or response body leaves this boundary.
 */
export async function verifyDispatchTemporalKeyIdentity({ version, api, request = fetch }) {
  if (typeof version !== 'string' || !/^[1-9][0-9]*$/.test(version) || typeof api !== 'function' || typeof request !== 'function') fail();
  const secretVersion = `projects/urm-app-staging/secrets/TEMPORAL_WORKER_API_KEY/versions/${version}`;
  const controller = new AbortController(), deadline = Date.now() + 15000;
  const checkDeadline = () => { if (controller.signal.aborted || Date.now() >= deadline) fail(); };
  let timer, bytes;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, 15000); });
  try {
    return await Promise.race([expired, (async () => {
      const native = await api(`https://secretmanager.googleapis.com/v1/${secretVersion}:access`);
      checkDeadline(); // A late read cannot send credentials onward.
      if (native?.name?.replace('projects/251680231116/', 'projects/urm-app-staging/') !== secretVersion ||
        typeof native.payload?.data !== 'string' || native.payload.data.length > 22000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(native.payload.data)) fail();
      bytes = Buffer.from(native.payload.data, 'base64');
      if (!bytes.length || bytes.length > 16384 || String(crc32c(bytes)) !== String(native.payload.dataCrc32c) ||
        !/^[\x21-\x7e]+$/.test(bytes.toString('utf8'))) fail();
      const response = await request(endpoint, { method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${bytes.toString('utf8')}`, 'temporal-cloud-api-version': 'v0.23.0', Accept: 'application/json' } });
      checkDeadline();
      if (response.status !== 200 || response.redirected || !response.body ||
        response.url && response.url !== endpoint) fail();
      const reader = response.body.getReader();
      let size = 0; const chunks = [];
      try {
        while (true) {
          const part = await reader.read();
          checkDeadline();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 16384) fail();
          chunks.push(Buffer.from(part.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      checkDeadline();
      const identity = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const account = identity.serviceAccount, key = identity.principalApiKey;
      const scoped = account?.spec?.namespaceScopedAccess;
      if (identity.user || account?.id !== ownerId || account.state !== 'RESOURCE_STATE_ACTIVE' ||
        !only(account.spec, ['name', 'description', 'access', 'namespaceScopedAccess', 'projectScopedAccess']) ||
        !only(scoped, ['namespace', 'access']) || !only(scoped.access, ['permission', 'permissionDeprecated']) ||
        scoped.access.permissionDeprecated !== undefined && scoped.access.permissionDeprecated !== 'write' ||
        account.spec?.name !== 'urm-staging-worker' || account.spec.access != null || account.spec.projectScopedAccess != null ||
        scoped?.namespace !== 'urm-app-staging.qwejt' || scoped.access?.permission !== 'PERMISSION_WRITE' ||
        key?.state !== 'RESOURCE_STATE_ACTIVE' || key.spec?.ownerId !== ownerId ||
        key.spec.ownerType !== 'OWNER_TYPE_SERVICE_ACCOUNT' || key.spec.disabled !== false ||
        typeof key.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(key.id) ||
        !(Date.parse(key.spec.expiryTime ?? '') > Date.now() + 3600000)) fail();
      return { secretVersion, serviceAccountId: ownerId, apiKeyId: key.id, namespace: scoped.namespace,
        permission: 'PERMISSION_WRITE', expiryTime: key.spec.expiryTime, apiVersion: 'v0.23.0',
        keySHA256: createHash('sha256').update(bytes).digest('hex'),
        scope: 'operator authenticated exact numeric shared worker secret against native current identity; not Cloud Run runner access or execution proof' };
    })()]);
  } catch { return fail(); }
  finally { clearTimeout(timer); controller.abort(); bytes?.fill(0); }
}
