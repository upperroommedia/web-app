const { existsSync, readFileSync, rmSync, statSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

const packageDirectory = resolve(__dirname, '..');
const outputDirectory = resolve(packageDirectory, 'dist');
const tsconfigPath = resolve(packageDirectory, 'tsconfig.json');
const packageJson = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'));
const entrypoint = resolve(packageDirectory, packageJson.main);
const tscPath = require.resolve('typescript/bin/tsc');

rmSync(outputDirectory, { recursive: true, force: true });

const result = spawnSync(process.execPath, [tscPath, '-p', tsconfigPath], {
  cwd: packageDirectory,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) {
  throw new Error(`Process-audio build did not emit its declared entrypoint: ${packageJson.main}`);
}

console.log(`Verified process-audio entrypoint: ${packageJson.main}`);
