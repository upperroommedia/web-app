#!/usr/bin/env node
/** Explicit project, dry run by default. Never assigns a generation to a newer replacement. */
import { createRequire } from 'node:module';
import { derivePinnedImageSource } from './lib/legacy-image-source.mjs';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const projectId = option('--project');
const bucketName = option('--bucket');
const apply = args.includes('--apply');
if (!projectId || !bucketName)
  throw new Error(
    'Usage: node scripts/reconcile-legacy-image-generations.mjs --project PROJECT --bucket IMAGES_BUCKET [--apply] [--after IMAGE_ID]'
  );
const app = initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore(app),
  bucket = getStorage(app).bucket(bucketName);
let cursor = option('--after');
let scanned = 0,
  pinned = 0,
  reviewed = 0;
while (true) {
  let query = db.collection('images').orderBy(FieldPath.documentId()).limit(100);
  if (cursor) query = query.startAfter(cursor);
  const page = await query.get();
  for (const snapshot of page.docs) {
    scanned++;
    const image = snapshot.data();
    if (image.source?.generation) {
      cursor = snapshot.id;
      continue;
    }
    try {
      const preliminary = derivePinnedImageSource(image, undefined, bucketName);
      const file = bucket.file(preliminary.path);
      const [metadata] = await file.getMetadata();
      const source = derivePinnedImageSource(image, metadata, bucketName);
      if (apply)
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(snapshot.ref);
          if (!fresh.exists || !fresh.updateTime.isEqual(snapshot.updateTime))
            throw new Error('image_changed_during_reconciliation');
          if (fresh.get('source.generation')) return;
          tx.update(snapshot.ref, { source, sourceGenerationReconciledAt: Date.now() });
        });
      pinned++;
      console.log(
        JSON.stringify({ imageId: snapshot.id, outcome: apply ? 'pinned' : 'would_pin', generation: source.generation })
      );
    } catch (error) {
      reviewed++;
      // Provider exceptions can contain URLs or credentials. Emit only controlled status.
      const known = [
        'not_a_canonical_image_storage_source',
        'invalid_storage_generation_or_type',
        'source_was_replaced_after_image_publication',
        'canonical_download_token_no_longer_matches',
        'image_changed_during_reconciliation',
      ];
      console.log(
        JSON.stringify({
          imageId: snapshot.id,
          outcome: 'requires_review',
          reason: known.includes(error?.message) ? error.message : 'source_verification_failed',
        })
      );
    }
    cursor = snapshot.id;
  }
  console.log(JSON.stringify({ checkpoint: cursor, scanned, pinned, reviewed, apply }));
  if (page.size < 100) break;
}
