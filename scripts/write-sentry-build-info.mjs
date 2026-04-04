import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [, , outputArg] = process.argv;

if (!outputArg) {
  console.error('Usage: node scripts/write-sentry-build-info.mjs <output-path>');
  process.exit(64);
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outputPath = path.resolve(repoRoot, outputArg);

const readEnvValue = (...keys) => {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return '';
};

const resolveGitSha = () => {
  const envGitSha = readEnvValue(
    'SENTRY_GIT_SHA',
    'GITHUB_SHA',
    'COMMIT_SHA',
    'SOURCE_VERSION',
    'GOOGLE_CLOUD_BUILD_SOURCE_VERSION',
    'FIREBASE_GIT_COMMIT_SHA'
  );

  if (envGitSha) {
    return envGitSha;
  }

  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const gitSha = resolveGitSha();
const fileContents = `export const sentryBuildGitSha = ${gitSha ? `'${gitSha}'` : 'null'} as const;\n`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, fileContents, 'utf8');
