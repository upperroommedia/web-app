/** Run only in the dedicated firebase.test.json emulator slot, never against dev or ADC. */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

jest.mock('../../src/temporal/provider', () => ({
  createEmailProviderRuntime: jest.fn(() => {
    throw new Error('LIVE_EMAIL_FACTORY_FORBIDDEN');
  }),
}));
const integration = process.env.URM_EMAIL_CAPTURE_EMULATOR_TEST === 'true' ? test : test.skip;
integration(
  'real Admin SDK binds capture to its database and preserves immutable delivery receipts without SMTP',
  async () => {
    const testConfigPath = process.env.URM_EMAIL_CAPTURE_TEST_CONFIG;
    if (!testConfigPath) throw new Error('Exact firebase.test.json path required');
    const config = JSON.parse(readFileSync(resolve(testConfigPath), 'utf8'));
    const port = config.emulators.firestore.port;
    const host = process.env.FIRESTORE_EMULATOR_HOST;
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(host || '') || port !== 18081)
      throw new Error('Dedicated Firestore test emulator required');
    const attempts: string[] = [],
      restores: Array<() => void> = [];
    const patch = (object: any, key: string, implementation: (original: any, ...args: any[]) => any) => {
      const original = object[key];
      object[key] = function (...args: any[]) {
        return implementation(original.bind(this), ...args);
      };
      restores.push(() => {
        object[key] = original;
      });
    };
    const forbidden = (name: string) => {
      attempts.push(name);
      throw new Error('Forbidden external test connection: ' + name);
    };
    const loopback = (hostname: unknown) => hostname === '127.0.0.1' || hostname === 'localhost';
    for (const protocol of ['node:http', 'node:https'])
      for (const method of ['get', 'request'])
        patch(require(protocol), method, () => forbidden(protocol + '.' + method));
    patch(require('node:http2'), 'connect', (original, authority, ...args) => {
      const url = new URL(String(authority));
      if (!loopback(url.hostname) || Number(url.port) !== port || url.protocol !== 'http:') return forbidden('http2');
      return original(authority, ...args);
    });
    patch(require('node:net').Socket.prototype, 'connect', (original, ...input) => {
      const args = Array.isArray(input[0]) ? input[0] : input;
      const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
      if (!options || options.path || !loopback(options.host || options.hostname) || Number(options.port) !== port)
        return forbidden('socket');
      return original(...input);
    });
    patch(require('node:tls'), 'connect', () => forbidden('tls'));
    patch(require('node:dgram'), 'createSocket', () => forbidden('udp'));
    for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) {
      patch(require('node:dns'), method, (original, hostname, ...args) => {
        if (!loopback(hostname)) return forbidden('dns.' + method);
        return original(hostname, ...args);
      });
    }
    for (const method of Object.keys(require('node:dns').promises).filter((k) => /^(lookup|resolve|reverse)/.test(k)))
      patch(require('node:dns').promises, method, (original, hostname, ...args) => {
        if (!loopback(hostname)) return forbidden('dns.promises.' + method);
        return original(hostname, ...args);
      });
    patch(globalThis, 'fetch', () => forbidden('fetch'));
    const originalMode = process.env.STAGING_PROVIDER_MODE;
    process.env.STAGING_PROVIDER_MODE = 'sandbox';
    let app: any, other: any, db: any;
    const owned: string[] = [];
    try {
      const { initializeApp, cert, getApps } = require('firebase-admin/app');
      const { getFirestore } = require('firebase-admin/firestore');
      const { createEmailRuntime } = require('../../src/temporal/runtime');
      const { deliverDurableEmail, emailMessageId } = require('../../src/temporal/delivery');
      const { createEmailProviderRuntime } = require('../../src/temporal/provider');
      if (getApps().length) throw new Error('Isolated kit SDK registry required; will not replace existing apps');
      const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const credential = cert({
        projectId: 'urm-app-staging',
        clientEmail: 'owned-emulator-fixture@urm-app-staging.iam.gserviceaccount.com',
        privateKey: key,
      });
      const token = jest
        .spyOn(credential, 'getAccessToken')
        .mockRejectedValue(new Error('ADC_OR_TOKEN_REQUEST_FORBIDDEN'));
      app = initializeApp({ projectId: 'urm-app-staging', credential });
      db = getFirestore(app, '(default)');
      const runtime = createEmailRuntime(db);
      expect(runtime.deliveryProfile.mode).toBe('capture');
      other = initializeApp({ projectId: 'urm-app-staging', credential }, 'mail-capture-owned-' + randomUUID());
      expect(() => createEmailRuntime(getFirestore(other, '(default)'))).toThrow('EMAIL_PROJECT_UNVERIFIED');
      const id = 'mail-capture-owned-' + randomUUID(),
        mailPath = 'mail/' + id;
      const ref = { projectId: 'urm-app-staging', jobId: id };
      const messageId = emailMessageId(ref.projectId, id),
        captureId = createHash('sha256').update(messageId).digest('hex');
      const headId = createHash('sha256')
        .update(JSON.stringify([ref.projectId, 'mail', mailPath, 'email']))
        .digest('hex');
      const payload = {
        to: ['recipient@example.invalid'],
        cc: ['copy@example.invalid'],
        bcc: ['hidden@example.invalid'],
        message: { subject: 'Owned emulator fixture', text: 'Private capture body' },
      };
      owned.push(
        mailPath,
        'durableJobs/' + id,
        'durableJobEntities/' + headId,
        'durableEmailReceipts/' + id,
        '_mailSandboxCaptures/' + captureId
      );
      await db.doc(mailPath).create(payload);
      await db
        .doc('durableJobs/' + id)
        .create({ state: 'running', entity: { type: 'mail', id: mailPath }, generation: 1 });
      await db.doc('durableJobEntities/' + headId).create({ activeJobId: id, generation: 1 });
      const prepared = await runtime.prepare(payload, messageId);
      expect(prepared).toMatchObject({
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      let fences = 0;
      expect(
        await deliverDurableEmail(
          db,
          runtime,
          ref,
          { mailPath, payload },
          {
            assertCurrent: async () => {
              fences++;
              const beforeCapture = await db.doc('durableEmailReceipts/' + id).get();
              expect(beforeCapture.get('state')).toBe('sending');
              expect(beforeCapture.get('deliveryProfile')).toEqual(runtime.deliveryProfile);
            },
            assertInTransaction: async () => {
              fences++;
            },
          }
        )
      ).toBe('confirmed');
      expect(fences).toBeGreaterThan(0);
      const receiptRef = db.doc('durableEmailReceipts/' + id),
        captureRef = db.doc('_mailSandboxCaptures/' + captureId);
      const receipt = await receiptRef.get(),
        captured = await captureRef.get();
      expect(receipt.get('state')).toBe('accepted');
      expect(receipt.get('deliveryProfile')).toEqual(runtime.deliveryProfile);
      expect(captured.get('options')).toEqual(prepared);
      expect(captured.get('externalDelivery')).toBe(false);
      expect((await db.doc(mailPath).get()).get('delivery.deliveryTransport.captureId')).toBe(captureId);
      expect(receipt.get('info.deliveryTransport.payloadSha256')).toBe(captured.get('payloadSha256'));
      await Promise.all([runtime.send(prepared), runtime.send(prepared)]);
      expect((await captureRef.get()).updateTime.isEqual(captured.updateTime)).toBe(true);
      await expect(runtime.send({ ...prepared, text: 'conflicting content' })).rejects.toThrow(
        'EMAIL_CAPTURE_CONTENT_CONFLICT'
      );
      expect((await captureRef.get()).updateTime.isEqual(captured.updateTime)).toBe(true);
      const refusedMessageId = emailMessageId(ref.projectId, id + '-refused');
      const refusedCapturePath = '_mailSandboxCaptures/' + createHash('sha256').update(refusedMessageId).digest('hex');
      owned.push(refusedCapturePath);
      await expect(
        runtime.send({ ...prepared, messageId: refusedMessageId }, async () => {
          throw new Error('STALE_FIXTURE');
        })
      ).rejects.toThrow('STALE_FIXTURE');
      expect((await db.doc(refusedCapturePath).get()).exists).toBe(false);
      // A real persisted historical live receipt cannot be silently adopted into capture.
      const historicalId = id + '-historical',
        historicalPath = 'durableEmailReceipts/' + historicalId;
      owned.push(historicalPath);
      await db.doc(historicalPath).create({ state: 'unknown', options: { to: ['private@example.invalid'] } });
      const historical = await db.doc(historicalPath).get();
      await expect(
        deliverDurableEmail(db, runtime, { ...ref, jobId: historicalId }, { mailPath, payload })
      ).rejects.toThrow('EMAIL_DELIVERY_PROFILE_MISMATCH');
      expect((await db.doc(historicalPath).get()).updateTime.isEqual(historical.updateTime)).toBe(true);
      expect(createEmailProviderRuntime).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
      expect(attempts).toEqual([]);
      runtime.close();
    } finally {
      if (db && owned.length) {
        const batch = db.batch();
        for (const path of owned) batch.delete(db.doc(path));
        await batch.commit();
      }
      const { deleteApp } = require('firebase-admin/app');
      if (other) await deleteApp(other);
      if (app) await deleteApp(app);
      if (originalMode === undefined) delete process.env.STAGING_PROVIDER_MODE;
      else process.env.STAGING_PROVIDER_MODE = originalMode;
      for (const restore of restores.reverse()) restore();
    }
  },
  30_000
);
