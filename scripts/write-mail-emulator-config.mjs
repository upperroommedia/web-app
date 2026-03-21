#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootDir = process.cwd();
const firebaseConfigPath = path.join(rootDir, 'firebase.json');
const outputPath = path.join(rootDir, 'firebase.mail.json');

const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));

const cachedExtensionPath = path.join(
  process.env.FIREBASE_EXTENSIONS_CACHE_PATH ?? path.join(os.homedir(), '.cache', 'firebase', 'extensions'),
  'firebase',
  'firestore-send-email@0.2.6'
);

if (!fs.existsSync(path.join(cachedExtensionPath, 'extension.yaml'))) {
  throw new Error(`Missing cached firestore-send-email extension source at ${cachedExtensionPath}`);
}

firebaseConfig.extensions = {
  'firestore-send-email': cachedExtensionPath,
};

fs.writeFileSync(outputPath, `${JSON.stringify(firebaseConfig, null, 2)}\n`);
