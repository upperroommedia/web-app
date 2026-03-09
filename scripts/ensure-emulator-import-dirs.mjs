#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const importRoot = path.resolve(process.cwd(), 'dir');
const metadataPath = path.join(importRoot, 'firebase-export-metadata.json');

if (!fs.existsSync(metadataPath)) {
  process.exit(0);
}

const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const services = ['auth', 'database', 'firestore', 'storage'];
const importRootPrefix = `${importRoot}${path.sep}`;

for (const service of services) {
  const relativePath = metadata?.[service]?.path;
  if (!relativePath) {
    continue;
  }

  const absolutePath = path.resolve(importRoot, relativePath);

  if (!absolutePath.startsWith(importRootPrefix)) {
    throw new Error(`Refusing to create import path outside ${importRoot}: ${relativePath}`);
  }

  if (fs.existsSync(absolutePath)) {
    const stats = fs.statSync(absolutePath);
    if (!stats.isDirectory()) {
      throw new Error(`Import path exists but is not a directory: ${absolutePath}`);
    }
    continue;
  }

  fs.mkdirSync(absolutePath, { recursive: true });
}
