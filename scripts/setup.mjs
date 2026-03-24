#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

const cwd = process.cwd();
const envPath = path.join(cwd, '.env');
const templatePath = path.join(cwd, '.env.template');
const firebasercPath = path.join(cwd, '.firebaserc');

const DEFAULT_BOOTSTRAP_PROJECT_ID = 'urm-app';
const DEFAULT_FUNCTIONS_REGION = 'us-central1';
const TEMPLATE_SECRET_SKIP_KEYS = new Set([
  'FIREBASE_PROJECT_ID',
  'FIREBASE_FUNCTIONS_REGION',
  'NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION',
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_DATABASE_URL',
  'NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL',
  'NEXT_PUBLIC_FIREBASE_IMAGES_BUCKET',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_DATABASE_URL',
  'FIREBASE_IMAGES_BUCKET',
]);

const parseCliArgs = (argv) => {
  const args = {
    projectId: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project' || token === '-P') {
      args.projectId = argv[index + 1]?.trim() || '';
      index += 1;
      continue;
    }
    if (token.startsWith('--project=')) {
      args.projectId = token.slice('--project='.length).trim();
    }
  }

  return args;
};

const parseEnv = (content) => {
  const parsed = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (key) parsed[key] = value;
  }
  return parsed;
};

const parseKeys = (content) =>
  content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && line.includes('='))
    .map((line) => line.split('=')[0]?.trim())
    .filter(Boolean);

const formatEnvValue = (value) => {
  const raw = String(value ?? '');
  if (raw.length === 0) return '';
  if (/[\s#]/.test(raw)) return JSON.stringify(raw);
  return raw;
};

const upsertEnvEntries = (content, entries) => {
  const lines = content.split('\n');
  for (const [key, value] of Object.entries(entries)) {
    const replacement = `${key}=${formatEnvValue(value)}`;
    const lineIndex = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
    if (lineIndex >= 0) {
      lines[lineIndex] = replacement;
    } else {
      lines.push(replacement);
    }
  }
  return lines.join('\n').replace(/\n*$/, '\n');
};

const removeEnvKeys = (content, keysToRemove) => {
  const removeSet = new Set(keysToRemove);
  const lines = content.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return true;
    const key = trimmed.split('=')[0]?.trim();
    return !removeSet.has(key);
  });
  return lines.join('\n').replace(/\n*$/, '\n');
};

const migrateLegacySubsplashKeys = (content) => {
  const values = parseEnv(content);
  const updates = {};

  if (!values.SUBSPLASH_EMAIL && values.EMAIL) {
    updates.SUBSPLASH_EMAIL = values.EMAIL;
  }
  if (!values.SUBSPLASH_PASSWORD && values.PASSWORD) {
    updates.SUBSPLASH_PASSWORD = values.PASSWORD;
  }

  let nextContent = content;
  if (Object.keys(updates).length > 0) {
    nextContent = upsertEnvEntries(nextContent, updates);
  }

  const hadLegacyKeys = values.EMAIL !== undefined || values.PASSWORD !== undefined;
  if (hadLegacyKeys) {
    nextContent = removeEnvKeys(nextContent, ['EMAIL', 'PASSWORD']);
  }

  return {
    content: nextContent,
    addedCount: Object.keys(updates).length,
    removedLegacy: hadLegacyKeys,
  };
};

const extractJsonFromFirebaseOutput = (output) => {
  const jsonStart = output.indexOf('{');
  if (jsonStart < 0) {
    throw new Error('Command did not return JSON output');
  }
  return JSON.parse(output.slice(jsonStart));
};

const runFirebaseJson = (args) => {
  const output = execFileSync('pnpm', ['exec', 'firebase', ...args, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const parsed = extractJsonFromFirebaseOutput(output);
  if (parsed.status === 'error') {
    throw new Error(parsed.error ?? 'Unknown Firebase CLI error');
  }
  return parsed;
};

const accessAppHostingSecret = (projectId, secretName) => {
  try {
    return execFileSync('pnpm', ['exec', 'firebase', 'apphosting:secrets:access', secretName, '--project', projectId], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
};

const readConfiguredProjectIds = () => {
  if (!fs.existsSync(firebasercPath)) return [];

  try {
    const raw = fs.readFileSync(firebasercPath, 'utf8');
    const parsed = JSON.parse(raw);
    const aliases = parsed?.projects;
    if (!aliases || typeof aliases !== 'object') return [];
    const projectIds = Object.values(aliases).filter((value) => typeof value === 'string' && value.trim().length > 0);
    return [...new Set(projectIds)];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[setup] unable to parse .firebaserc: ${message}`);
    return [];
  }
};

const chooseDefaultProjectId = (projectIds) => {
  if (projectIds.includes(DEFAULT_BOOTSTRAP_PROJECT_ID)) return DEFAULT_BOOTSTRAP_PROJECT_ID;
  if (projectIds.length > 0) return projectIds[0];
  return DEFAULT_BOOTSTRAP_PROJECT_ID;
};

const promptForProjectId = async (projectIds) => {
  const defaultProjectId = chooseDefaultProjectId(projectIds);

  if (projectIds.length <= 1) return defaultProjectId;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`[setup] Non-interactive shell detected; using Firebase project ${defaultProjectId}.`);
    return defaultProjectId;
  }

  console.log('[setup] Select Firebase project for `.env` bootstrap:');
  projectIds.forEach((projectId, index) => {
    const label = projectId === defaultProjectId ? `${projectId} (default)` : projectId;
    console.log(`  ${index + 1}) ${label}`);
  });

  const defaultIndex = projectIds.indexOf(defaultProjectId) + 1;
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (await rl.question(`[setup] Enter choice [${defaultIndex}]: `)).trim();
      if (answer.length === 0) return defaultProjectId;

      const asIndex = Number(answer);
      if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= projectIds.length) {
        return projectIds[asIndex - 1];
      }

      if (projectIds.includes(answer)) {
        return answer;
      }

      console.log('[setup] Invalid choice. Enter a number from the list or an exact project ID.');
    }
  } finally {
    rl.close();
  }
};

const resolveBootstrapProjectId = async (requestedProjectId) => {
  const configuredProjectIds = readConfiguredProjectIds();
  const defaultProjectId = chooseDefaultProjectId(configuredProjectIds);

  if (requestedProjectId) {
    if (configuredProjectIds.length > 0 && !configuredProjectIds.includes(requestedProjectId)) {
      console.warn(
        `[setup] Project ${requestedProjectId} is not listed in .firebaserc; continuing because it was explicitly requested.`
      );
    }
    return requestedProjectId;
  }

  if (configuredProjectIds.length === 0) {
    console.log(`[setup] No projects found in .firebaserc; using ${defaultProjectId}.`);
    return defaultProjectId;
  }

  return promptForProjectId(configuredProjectIds);
};

const buildBootstrapValues = (projectId, templateKeys) => {
  console.log(`[setup] Starting Firebase bootstrap for project ${projectId}...`);
  const values = {
    FIREBASE_PROJECT_ID: projectId,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
    FIREBASE_FUNCTIONS_REGION: DEFAULT_FUNCTIONS_REGION,
    NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION: DEFAULT_FUNCTIONS_REGION,
    NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL: `https://${DEFAULT_FUNCTIONS_REGION}-${projectId}.cloudfunctions.net`,
    FIREBASE_IMAGES_BUCKET: `${projectId}-images`,
    NEXT_PUBLIC_FIREBASE_IMAGES_BUCKET: `${projectId}-images`,
  };

  console.log('[setup] [1/3] Fetching Firebase Web SDK config...');
  try {
    const appList = runFirebaseJson(['apps:list', 'WEB', '--project', projectId]).result ?? [];
    const webApp = appList[0];
    if (webApp?.appId) {
      const sdkConfig =
        runFirebaseJson(['apps:sdkconfig', 'WEB', webApp.appId, '--project', projectId]).result?.sdkConfig ?? {};
      if (sdkConfig.apiKey) values.NEXT_PUBLIC_FIREBASE_API_KEY = sdkConfig.apiKey;
      if (sdkConfig.appId) values.NEXT_PUBLIC_FIREBASE_APP_ID = sdkConfig.appId;
      if (sdkConfig.messagingSenderId) values.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = sdkConfig.messagingSenderId;
      if (sdkConfig.authDomain) values.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = sdkConfig.authDomain;
      if (sdkConfig.storageBucket) {
        values.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = sdkConfig.storageBucket;
        values.FIREBASE_STORAGE_BUCKET = sdkConfig.storageBucket;
      }
      if (sdkConfig.databaseURL) {
        values.NEXT_PUBLIC_FIREBASE_DATABASE_URL = sdkConfig.databaseURL;
        values.FIREBASE_DATABASE_URL = sdkConfig.databaseURL;
      }
      console.log(`[setup] [1/3] Firebase Web SDK config loaded from app ${webApp.appId}.`);
    } else {
      console.log('[setup] [1/3] No Firebase Web app found; skipped SDK config hydration.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[setup] unable to fetch Firebase web app config for ${projectId}: ${message}`);
  }

  const secretLookupKeys = templateKeys.filter((key) => !TEMPLATE_SECRET_SKIP_KEYS.has(key));

  console.log(`[setup] [2/3] Resolving App Hosting secrets (${secretLookupKeys.length} key(s))...`);
  let secretsFound = 0;
  let secretsMissing = 0;
  for (let index = 0; index < secretLookupKeys.length; index += 1) {
    const envVar = secretLookupKeys[index];
    if (values[envVar]) {
      continue;
    }

    const value = accessAppHostingSecret(projectId, envVar);
    if (value) {
      values[envVar] = value;
      secretsFound += 1;
      console.log(`[setup] [2/3] (${index + 1}/${secretLookupKeys.length}) ${envVar}: found`);
    } else {
      secretsMissing += 1;
      console.log(`[setup] [2/3] (${index + 1}/${secretLookupKeys.length}) ${envVar}: not found`);
    }
  }
  console.log(`[setup] [2/3] Secret resolution complete (found ${secretsFound}, missing ${secretsMissing}).`);
  console.log('[setup] [3/3] Finalizing .env values...');

  return values;
};

if (!fs.existsSync(templatePath)) {
  console.error('[setup] Missing .env.template');
  process.exit(1);
}

const cliArgs = parseCliArgs(process.argv.slice(2));
const templateContent = fs.readFileSync(templatePath, 'utf8');
const templateKeys = new Set(parseKeys(templateContent));
let createdEnv = false;

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(templatePath, envPath);
  createdEnv = true;
  console.log('[setup] Created .env from .env.template');
}

let envContent = fs.readFileSync(envPath, 'utf8');
const envValues = parseEnv(envContent);
const envKeys = new Set(Object.keys(envValues));
const missingTemplateKeys = [...templateKeys].filter((key) => !envKeys.has(key));

if (missingTemplateKeys.length > 0) {
  const templateLinesByKey = new Map(
    templateContent
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('#') && trimmed.includes('=');
      })
      .map((line) => [line.split('=')[0]?.trim(), line])
  );

  const linesToAppend = missingTemplateKeys.map((key) => templateLinesByKey.get(key)).filter(Boolean);

  const prefix = envContent.endsWith('\n') ? '' : '\n';
  const block = ['# Added by `pnpm run setup:env`', ...linesToAppend, ''].join('\n');
  envContent = `${envContent}${prefix}${block}`;
  fs.writeFileSync(envPath, envContent);
  console.log(`[setup] Added ${linesToAppend.length} missing key(s) from .env.template`);
}

const migration = migrateLegacySubsplashKeys(envContent);
if (migration.content !== envContent) {
  envContent = migration.content;
  fs.writeFileSync(envPath, envContent);
  if (migration.addedCount > 0 || migration.removedLegacy) {
    console.log(
      `[setup] Migrated Subsplash env keys (added ${migration.addedCount}, removed legacy EMAIL/PASSWORD entries).`
    );
  }
}

if (!createdEnv) {
  console.log('[setup] Existing .env detected; skipped Firebase bootstrap pull');
  process.exit(0);
}

const bootstrapProjectId = await resolveBootstrapProjectId(cliArgs.projectId);
const bootstrapValues = buildBootstrapValues(bootstrapProjectId, [...templateKeys]);
envContent = fs.readFileSync(envPath, 'utf8');
envContent = upsertEnvEntries(envContent, bootstrapValues);
fs.writeFileSync(envPath, envContent);

console.log(`[setup] Bootstrapped new .env from Firebase project ${bootstrapProjectId}`);
console.log(
  `[setup] Wrote ${Object.keys(bootstrapValues).length} key(s). You can override any value in .env or .env.local.`
);
