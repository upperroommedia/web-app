import { spawnSync } from 'node:child_process';

const child = spawnSync(
  'pnpm',
  [
    '--dir',
    'functions',
    'exec',
    'ts-node',
    '--transpile-only',
    'src/helpers/backfillSeriesItemSubtitles.ts',
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    cwd: process.cwd(),
  }
);

if (child.error) {
  throw child.error;
}

process.exitCode = child.status ?? 1;
