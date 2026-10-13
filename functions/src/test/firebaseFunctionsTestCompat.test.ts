import express from 'express';
import { createServer } from 'node:http';
import functionsTest from 'firebase-functions-test';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { GeoPoint, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';

// Run through firebase.test.json: the online assertion must never reach a
// production Firestore instance if an emulator process was not started.
describe('firebase-functions-test Admin 14 compatibility patch', () => {
  const config = { projectId: 'urm-app', storageBucket: 'urm-app.appspot.com' };

  it('encodes current SDK classes and respects the explicit Firebase application', async () => {
    const app = initializeApp(config, 'functions-test-admin14-classes');
    const harness = functionsTest(config);
    try {
      const db = getFirestore(app);
      const reference = db.doc('sdkCompatibility/reference');
      const timestamp = Timestamp.fromMillis(1700000000123);
      const point = new GeoPoint(10.25, -20.5);
      const snapshot = harness.firestore.makeDocumentSnapshot(
        { reference, timestamp, point, bytes: Buffer.from('value') },
        'sdkCompatibility/snapshot',
        { firebaseApp: app }
      );
      expect(snapshot.ref.firestore).toBe(db);
      expect(snapshot.get('reference').isEqual(reference)).toBe(true);
      expect(snapshot.get('timestamp').isEqual(timestamp)).toBe(true);
      expect(snapshot.get('point').isEqual(point)).toBe(true);
      expect(snapshot.get('bytes').toString()).toBe('value');
    } finally {
      await harness.cleanup();
      await deleteApp(app);
    }
  });

  it('creates and awaits deletion of the library test app across consecutive harnesses', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const harness = functionsTest(config);
      harness.firestore.makeDocumentSnapshot({ attempt }, 'sdkCompatibility/lifecycle');
      expect(getApps().some((app) => app.name === 'firebase-functions-test')).toBe(true);
      await harness.cleanup();
      expect(getApps().some((app) => app.name === 'firebase-functions-test')).toBe(false);
    }
  });

  it('wraps a callable that performs a real emulator write using the same Admin SDK', async () => {
    expect(process.env.FIRESTORE_EMULATOR_HOST).toMatch(/^(127\.0\.0\.1|localhost):18081$/);
    const harness = functionsTest(config);
    const db = getFirestore();
    const reference = db.collection('sdkCompatibility').doc('callable-admin14');
    const handler = onCall(async (request) => {
      await reference.set({ actor: request.auth?.uid, value: request.data.value });
      return { recorded: true };
    });
    const wrapped = harness.wrap(handler);
    const httpApp = express();
    httpApp.post('/compat', async (request, response) => {
      try {
        // A real Express request gives the wrapper valid stream/socket methods;
        // only Firebase's additional rawBody property is added by this fixture.
        const rawRequest = Object.assign(request, { rawBody: Buffer.alloc(0) });
        const result = await wrapped({
          data: { value: 42 },
          rawRequest,
          acceptsStreaming: false,
          auth: {
            uid: 'compat-user',
            rawToken: 'synthetic-compat-token',
            token: {
              uid: 'compat-user',
              sub: 'compat-user',
              aud: 'urm-app',
              iss: 'https://securetoken.google.com/urm-app',
              iat: 1,
              exp: 9999999999,
              auth_time: 1,
              firebase: { identities: {}, sign_in_provider: 'custom' },
            },
          },
        });
        response.json(result);
      } catch (error) {
        response.status(500).json({ error: String(error) });
      }
    });
    const server = createServer(httpApp);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a local HTTP fixture port.');
      const response = await fetch(`http://127.0.0.1:${address.port}/compat`, { method: 'POST' });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ recorded: true });
      expect((await reference.get()).data()).toEqual({ actor: 'compat-user', value: 42 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await reference.delete();
      await harness.cleanup();
    }
  });
});
