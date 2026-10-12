import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backendTargets = [
  'deploy_function_kits', 'deploy_firestore', 'deploy_database', 'deploy_storage',
  'deploy_functions_core', 'deploy_functions_media', 'deploy_functions_image', 'deploy_functions_integrations',
];
const outputNames = [...backendTargets, 'deploy_web_app', 'anything_to_firebase_deploy', 'anything_to_run'];
const cases = [
  ['firebase.json', backendTargets],
  ['.firebaserc', backendTargets],
  ['.github/actions/setup-backend-deploy/action.yml', backendTargets],
  ['scripts/firebase-deploy-with-quota-retry.sh', backendTargets],
  ['scripts/materialize-catalog-for-firebase.mjs', backendTargets],
  ['scripts/write-sentry-build-info.mjs', backendTargets],
  ['function-kits/sample/source/index.ts', ['deploy_function_kits']],
  ['scripts/create-kit-deploy-config.mjs', backendTargets],
  ['apps/web/pages/index.tsx', ['deploy_web_app']],
  ['functions-core/index.ts', ['deploy_functions_core']],
  ['docs/README.md', []],
];

for (const branch of ['main', 'staging']) {
  const file = fileURLToPath(new URL(`../.github/workflows/${branch}-selective-deploy.yml`, import.meta.url));
  const workflow = readFileSync(file, 'utf8');
  const start = workflow.indexOf('          changed_files_for_functions=');
  const end = workflow.indexOf('          {\n            echo "deploy_function_kits=', start);
  assert(start >= 0 && end > start, `Cannot find detection block in ${file}`);
  const detection = workflow.slice(start, end).replace(/^          /gm, '');
  const checks = [...cases, [`.github/workflows/${branch}-selective-deploy.yml`, backendTargets]];
  for (const [changedPath, enabledTargets] of checks) {
    const script = `set -euo pipefail\nchanged_files="$CHANGED_FILES"\nforce_full=false\n${detection}\n` +
      outputNames.map(name => `printf '%s=%s\\n' '${name}' "$${name}"`).join('\n');
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, CHANGED_FILES: changedPath }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${branch}: ${changedPath}: ${result.stderr}`);
    const actual = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')));
    for (const target of [...backendTargets, 'deploy_web_app']) {
      assert.equal(actual[target], String(enabledTargets.includes(target)), `${branch}: ${changedPath}: ${target}`);
    }
    assert.equal(actual.anything_to_run, String(enabledTargets.length > 0), `${branch}: ${changedPath}: workflow action`);
    assert.equal(actual.anything_to_firebase_deploy, String(enabledTargets.some(target => backendTargets.includes(target))),
      `${branch}: ${changedPath}: backend deploy`);
  }
}
console.log('Selective deploy detection passed 24 regression cases.');
