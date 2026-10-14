import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const functions = resolve(root, 'functions');
const require = createRequire(resolve(functions, 'package.json'));
const ts = require('typescript');
const scripts = JSON.parse(readFileSync(resolve(functions, 'package.json'), 'utf8')).scripts;
const configPath = resolve(functions, 'tsconfig.test.json');
const raw = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(raw.error, undefined);
const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, functions);
assert.deepEqual(parsed.errors, []);

test('strict typecheck covers every actual Jest-discovered suite, including orchestration', () => {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('jest/bin/jest'),
      '--config',
      resolve(functions, 'jest.config.js'),
      '--listTests',
      '--json',
      '--watchman=false',
      '--runInBand',
    ],
    { cwd: functions, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  const suites = JSON.parse(result.stdout);
  assert(suites.length > 0, 'Jest must discover tests');
  assert(
    suites.some((file) => file.includes('/packages/orchestration/src/')),
    'Orchestration suites must be discovered'
  );
  const checked = new Set(parsed.fileNames.map((file) => resolve(file)));
  for (const suite of suites) assert(checked.has(resolve(suite)), `Suite omitted from mandatory typecheck: ${suite}`);
  assert.equal(parsed.options.strict, true);
  assert.equal(parsed.options.noImplicitReturns, true);
  assert.equal(parsed.options.noUnusedLocals, true);
  assert.equal(parsed.options.isolatedModules, true);
  assert.equal(parsed.options.noEmit, true);
  assert.equal(parsed.options.target, ts.ScriptTarget.ES2022);
});

test('strict compiler rejects a real type error without emitting output', () => {
  const filename = resolve(functions, '__pipeline_type_error__.ts');
  const source = 'export const value: string = 123;';
  const host = ts.createCompilerHost(parsed.options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
    file === filename
      ? ts.createSourceFile(file, source, languageVersion)
      : original(file, languageVersion, onError, shouldCreateNewSourceFile);
  host.writeFile = () => {
    throw new Error('Typechecking must never emit');
  };
  const program = ts.createProgram([filename], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert(
    diagnostics.some((diagnostic) => diagnostic.file?.fileName === filename && diagnostic.code === 2322),
    'The strict gate must reject a type mismatch'
  );
});

test('all test entrypoints stop before starting emulators if typechecking fails', () => {
  assert.equal(scripts['test:ci'], 'pnpm run test');
  assert.match(scripts['typecheck:tests'], /tsc --noEmit --project tsconfig\.test\.json$/);
  for (const name of ['test', 'test:verbose', 'test:temporal', 'test:series-locking:long']) {
    assert(scripts[name].startsWith('pnpm run typecheck:tests && '), `Mandatory gate missing: ${name}`);
    assert(scripts[name].includes('--config ../firebase.test.json'), `Dedicated config missing: ${name}`);
    const command = scripts[name]
      .replace('pnpm run typecheck:tests', `"$FUNCTIONS_PIPELINE_TEST_NODE" -e 'process.exit(23)'`)
      .replace(/firebase emulators:exec[\s\S]*$/, `"$FUNCTIONS_PIPELINE_TEST_NODE" -e 'process.exit(99)'`);
    const result = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: { ...process.env, FUNCTIONS_PIPELINE_TEST_NODE: process.execPath },
    });
    assert.equal(result.status, 23, `Typecheck failure must propagate before emulators: ${name}`);
  }
});
