#!/usr/bin/env node
/** Native routing of ONLY the four reviewed original parent runs; never a job mutation or migration claim. */
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonical } from './temporal-release-runtime.mjs';
import { pinRecoveryOperatorBindings } from './temporal-pinned-search-operator-binding.mjs';
import {
  parseArgs,
  assertPinnedParentRequest,
  createPinnedSearchRecoveryDependencies,
  recover,
} from './temporal-recover-pinned-search.mjs';
const need = (v, code) => {
  if (!v) throw Object.assign(new Error(code), { code });
};
export function parseParentOverrideArgs(args) {
  need(args[0] === 'override', 'PARENT_OVERRIDE_ONLY_ACTION_REQUIRED');
  const allowed = new Set([
    '--origin-operator-root',
    '--old-release',
    '--target-release',
    '--target-runtime-root',
    '--plan',
    '--plan-sha',
    '--workflow-id',
    '--run-id',
    '--output',
  ]);
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--apply') continue;
    need(allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), 'UNKNOWN_PARENT_ARGUMENT');
    i++;
  }
  const copy = [...args],
    i = copy.indexOf('--origin-operator-root');
  need(i > 0 && copy.lastIndexOf('--origin-operator-root') === i, 'EXACT_ORIGIN_OPERATOR_ROOT_REQUIRED');
  const originOperatorRoot = copy[i + 1];
  copy.splice(i, 2);
  const options = parseArgs(copy);
  assertPinnedParentRequest(options);
  return { options, originOperatorRoot };
}
export async function main(args) {
  const { options: o, originOperatorRoot } = parseParentOverrideArgs(args);
  try {
    lstatSync(o['--output']);
    throw Object.assign(new Error('FRESH_OUTPUT_REQUIRED'), { code: 'FRESH_OUTPUT_REQUIRED' });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const path = o['--target-release'],
    stat = lstatSync(path);
  need(
    resolve(path) === path && stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024,
    'REGULAR_BOUNDED_ARTIFACT_REQUIRED'
  );
  const target = JSON.parse(readFileSync(path));
  const currentRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const { origin, operatorBinding } = pinRecoveryOperatorBindings(
    currentRoot,
    originOperatorRoot,
    o['--target-runtime-root'],
    target
  );
  // Confirm the exact original reviewed bytes before creating credentials or exposing the native capability.
  const planStat = lstatSync(o['--plan']);
  need(
    resolve(o['--plan']) === o['--plan'] &&
      planStat.isFile() &&
      !planStat.isSymbolicLink() &&
      planStat.size <= 32 * 1024 * 1024,
    'REGULAR_BOUNDED_ARTIFACT_REQUIRED'
  );
  need(
    createHash('sha256').update(readFileSync(o['--plan'])).digest('hex') === o['--plan-sha'],
    'ARTIFACT_HASH_CHANGED'
  );
  const deps = await createPinnedSearchRecoveryDependencies(o, {
    originOperatorRoot: origin.operatorRoot,
    parentOverrideOnly: true,
  });
  let failure, result;
  try {
    result = await recover(o, deps, {}, { nativeOperatorBinding: operatorBinding });
  } catch (e) {
    failure = e;
  } finally {
    try {
      await deps.close();
    } catch (e) {
      failure ||= e;
    }
  }
  if (failure) throw failure;
  writeFileSync(
    o['--output'],
    JSON.stringify(canonical({ ...result, nativeOperatorBinding: operatorBinding }), null, 2) + '\n',
    { flag: 'wx', mode: 0o600 }
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.code || 'BOUNDED_PARENT_OVERRIDE_STOPPED_INSPECT_PRIVATE_AUDIT');
    process.exitCode = 1;
  });
