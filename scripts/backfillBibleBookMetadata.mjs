import admin from 'firebase-admin';

// Usage: node scripts/backfillBibleBookMetadata.mjs [--apply]
// Requires Application Default Credentials with Firestore write access to urm-app.
// The default mode only prints the proposed changes.
const projectId = process.env.FIREBASE_PROJECT_ID || 'urm-app';
const applyChanges = process.argv.includes('--apply');

// Order follows the 66-book Protestant canon, with existing deuterocanonical
// books placed after Malachi and before the New Testament. Missing Chronicles
// retain their canonical positions until Subsplash lists exist for them.
const canonicalOrder = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
  '1 Samuel', '2 Samuel', '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra', 'Nehemiah',
  'Esther', 'Job', 'Psalms', 'Proverbs', 'Ecclesiastes', 'Song of Songs', 'Isaiah', 'Jeremiah',
  'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos', 'Obadiah', 'Jonah', 'Micah', 'Nahum',
  'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah', 'Malachi', 'Tobit', 'Judith', '1 Maccabees',
  'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians', '2 Corinthians', 'Galatians',
  'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians', '2 Thessalonians', '1 Timothy',
  '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James', '1 Peter', '2 Peter', '1 John', '2 John',
  '3 John', 'Jude', 'Revelation',
];

const additionalBooks = [
  { id: 'c67fb318-7964-4497-833c-8c03544d7930', name: 'Leviticus' },
  { id: '8b5d8ff3-2972-47cb-bf03-41594471a03e', name: 'Numbers' },
  { id: '6f0cffd7-fb59-4a77-b3ee-c1eebf9e4354', name: 'Deuteronomy' },
  { id: 'b387becf-b112-4341-8b73-c88656deb5a3', name: 'Lamentations' },
  { id: 'aaa7ca37-c958-476d-8b5c-6453e6d049ab', name: 'Amos' },
  { id: '939ac376-9a6d-476f-9578-47b8dcdd3b50', name: 'Obadiah' },
  { id: '23e4ff1e-2e0c-4014-8e8d-ef3230e2c277', name: 'Nahum' },
  { id: '408f3416-df99-452b-b871-c86be67a413d', name: 'Zephaniah' },
];

const normalizeName = (value) => value.trim().replace(/\s+/g, ' ');
const positions = new Map(canonicalOrder.map((name, index) => [name, index + 1]));

if (projectId !== 'urm-app') {
  throw new Error(`Refusing to target unexpected Firebase project: ${projectId}`);
}

admin.initializeApp({ projectId });

try {
  const db = admin.firestore();
  const collection = db.collection('lists');
  const taggedSnapshot = await collection.where('listTagAndPosition.listTag', '==', 'bible-chapter').get();
  const updates = new Map();

  for (const doc of taggedSnapshot.docs) {
    const name = normalizeName(doc.get('name') || '');
    if (name === 'Character Studies') {
      updates.set(doc.ref.path, {
        ref: doc.ref,
        data: { listTagAndPosition: admin.firestore.FieldValue.delete() },
        removeFromBibleBookBundle: true,
      });
      continue;
    }

    const position = positions.get(name);
    if (!position) {
      throw new Error(`Unexpected tagged list ${doc.id} (${doc.get('name')}); review before backfilling.`);
    }
    updates.set(doc.ref.path, {
      ref: doc.ref,
      data: { listTagAndPosition: { listTag: 'bible-chapter', position } },
      removeFromBibleBookBundle: false,
    });
  }

  for (const book of additionalBooks) {
    const ref = collection.doc(book.id);
    const doc = await ref.get();
    if (!doc.exists) throw new Error(`Expected existing Subsplash/Firestore list ${book.name} (${book.id}).`);
    if (doc.get('id') !== book.id || doc.get('subsplashId') !== book.id) {
      throw new Error(`List ID mismatch for ${book.name} (${book.id}); refusing to update.`);
    }
    if (normalizeName(doc.get('name') || '') !== book.name) {
      throw new Error(`Unexpected list name for ${book.id}: ${doc.get('name')}; refusing to update.`);
    }
    updates.set(ref.path, {
      ref,
      data: { listTagAndPosition: { listTag: 'bible-chapter', position: positions.get(book.name) } },
      removeFromBibleBookBundle: false,
    });
  }

  const planned = [...updates.values()];
  const namesById = new Map([
    ...taggedSnapshot.docs.map((doc) => [doc.id, normalizeName(doc.get('name') || '')]),
    ...additionalBooks.map((book) => [book.id, book.name]),
  ]);
  console.log(JSON.stringify({
    projectId,
    mode: applyChanges ? 'apply' : 'dry-run',
    updates: planned.length,
    books: planned.map(({ ref, data }) => ({
      id: ref.id,
      name: namesById.get(ref.id),
      position: data.listTagAndPosition?.position ?? null,
      removeFromBibleBookBundle: updates.get(ref.path).removeFromBibleBookBundle,
    })),
  }, null, 2));

  if (applyChanges) {
    for (let i = 0; i < planned.length; i += 450) {
      const batch = db.batch();
      for (const { ref, data } of planned.slice(i, i + 450)) batch.update(ref, data);
      await batch.commit();
    }
    console.log(`Applied ${planned.length} Bible book metadata updates.`);
  } else {
    console.log('Dry run only. Re-run with --apply to write these changes.');
  }
} finally {
  await admin.app().delete();
}
