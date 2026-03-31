import firebaseAdmin from 'firebase-admin';
import { cert, type ServiceAccount } from 'firebase-admin/app';

function parseServiceAccountJson(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (!raw) {
    return null;
  }

  const decoded = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded) as Record<string, unknown>;
  const projectId =
    (typeof parsed.project_id === 'string' && parsed.project_id) ||
    (typeof parsed.projectId === 'string' && parsed.projectId) ||
    process.env.FIREBASE_PROJECT_ID;
  const clientEmail =
    (typeof parsed.client_email === 'string' && parsed.client_email) ||
    (typeof parsed.clientEmail === 'string' && parsed.clientEmail) ||
    '';
  const privateKeyRaw =
    (typeof parsed.private_key === 'string' && parsed.private_key) ||
    (typeof parsed.privateKey === 'string' && parsed.privateKey) ||
    '';

  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id, client_email, or private_key.');
  }

  return {
    projectId,
    clientEmail,
    privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
  };
}

if (!firebaseAdmin.apps.length) {
  const serviceAccount = parseServiceAccountJson();

  firebaseAdmin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    ...(serviceAccount ? { credential: cert(serviceAccount) } : {}),
  });
}

export default firebaseAdmin;
