import { randomUUID } from 'node:crypto';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';

const DEFAULT_EMULATOR_HOST = '127.0.0.1:8081';

function ensureFirestoreEmulator() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST ?? DEFAULT_EMULATOR_HOST;
  if (!emulatorHost.startsWith('127.0.0.1:') && !emulatorHost.startsWith('localhost:')) {
    throw new Error(`Refusing to seed sermons outside local emulator: ${emulatorHost}`);
  }
  process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
}

function getAdminDb() {
  ensureFirestoreEmulator();
  if (!getApps().length) {
    initializeApp({
      projectId: process.env.GCLOUD_PROJECT ?? 'urm-app',
    });
  }
  return getFirestore(getApp());
}

export interface SeededPlayableSermon {
  id: string;
  title: string;
  cleanup: () => Promise<void>;
}

export async function seedPlayableSermon(): Promise<SeededPlayableSermon> {
  const db = getAdminDb();
  const id = `pw-sermon-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const title = `Playwright Seeded Sermon ${id.slice(-6)}`;

  await db.collection('sermons').doc(id).set({
    title,
    subtitle: 'Seeded subtitle',
    description: 'Seeded sermon for deterministic Playwright coverage.',
    speakers: [{ name: 'Playwright Speaker' }],
    topics: ['playwright'],
    date: Timestamp.fromMillis(now),
    sourceStartTime: 0,
    durationSeconds: 180,
    status: {
      audioStatus: 'PROCESSED',
      soundCloud: 'NOT_UPLOADED',
      subsplash: 'NOT_UPLOADED',
    },
    images: [],
    numberOfLists: 0,
    numberOfListsUploadedTo: 0,
    createdAtMillis: now,
    editedAtMillis: now,
    uploaderId: 'playwright-e2e',
  });

  return {
    id,
    title,
    cleanup: async () => {
      await db.collection('sermons').doc(id).delete();
    },
  };
}
