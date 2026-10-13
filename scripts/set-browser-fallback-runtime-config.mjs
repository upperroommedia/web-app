#!/usr/bin/env node
import { getApps, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

import { BROWSER_FALLBACK_RUNTIME_CONFIG_PATH } from '../packages/contracts/browserFallback.js';

const [projectId, databaseUrl, serviceUrl = '', enabled = 'false'] = process.argv.slice(2);

if (!projectId || !databaseUrl) {
  console.error(
    'Usage: node scripts/set-browser-fallback-runtime-config.mjs <projectId> <databaseUrl> [serviceUrl] [enabled]'
  );
  process.exit(1);
}

if (!getApps().length) {
  initializeApp({
    projectId,
    databaseURL: databaseUrl,
  });
}

await getDatabase()
  .ref(BROWSER_FALLBACK_RUNTIME_CONFIG_PATH)
  .set({
    serviceUrl: serviceUrl || null,
    enabled: enabled === 'true' && !!serviceUrl,
    updatedAt: new Date().toISOString(),
  });

console.log(`Updated browser fallback runtime config at ${BROWSER_FALLBACK_RUNTIME_CONFIG_PATH}`);
