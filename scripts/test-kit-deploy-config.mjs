import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKitDeployConfig, selectKitDeployConfig, selectLegacyDeployConfig } from './create-kit-deploy-config.mjs';

const kit = { kit: 'sample-kit', source: 'function-kits/sample', instances: { one: 'function-kits/sample/config' },
  predeploy: ['npm --prefix "$RESOURCE_DIR" run build'] };
const input = { functions: [{ source: 'functions-core', codebase: 'core', predeploy: ['legacy-build'] }, kit],
  firestore: { rules: 'firestore.rules' }, emulators: { functions: { port: 5001 } } };
const output = selectKitDeployConfig(input);
assert.deepEqual(output.functions, [kit]);
assert.deepEqual(output.firestore, input.firestore);
assert.deepEqual(output.emulators, input.emulators);
assert.equal(input.functions.length, 2, 'selection must not mutate the root configuration');
assert.deepEqual(selectKitDeployConfig({ functions: kit }).functions, [kit]);
assert.throws(() => selectKitDeployConfig({ functions: [{ codebase: 'core' }] }), /does not register/);
assert.deepEqual(selectLegacyDeployConfig(input).functions, [input.functions[0]]);
assert.throws(() => selectLegacyDeployConfig({ functions: [kit] }), /does not register/);
assert.throws(() => createKitDeployConfig({ legacy: true, install: true }), /only appl/);
const searchKit = { ...kit, kit: 'firestore-algolia-search', source: 'function-kits/search' };
const mailKit = { ...kit, kit: 'firestore-send-email', source: 'function-kits/email' };
const imageKit = { ...kit, kit: 'image-processing-api', source: 'function-kits/image' };
const productionConfig = { ...input, functions: [...input.functions, searchKit, mailKit, imageKit] };
assert.deepEqual(selectKitDeployConfig(productionConfig).functions, [kit, searchKit, mailKit, imageKit]);
assert.deepEqual(selectKitDeployConfig(productionConfig, { withoutSearch: true }).functions, [kit, mailKit, imageKit]);
assert.deepEqual(productionConfig.functions, [...input.functions, searchKit, mailKit, imageKit], 'search filtering preserves production input');
assert.throws(() => createKitDeployConfig({ legacy: true, withoutSearch: true }), /only appl/);
const root = mkdtempSync(join(tmpdir(), 'firebase-kits-config-'));
try {
  writeFileSync(join(root, 'firebase.json'), JSON.stringify(input));
  const file = createKitDeployConfig({ root });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), output);
  const legacyFile = createKitDeployConfig({ root, legacy: true });
  assert.deepEqual(JSON.parse(readFileSync(legacyFile, 'utf8')), selectLegacyDeployConfig(input));
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8')), input);
  writeFileSync(join(root, 'firebase.json'), JSON.stringify(productionConfig));
  const stagingFile = createKitDeployConfig({ root, withoutSearch: true });
  assert.deepEqual(JSON.parse(readFileSync(stagingFile, 'utf8')).functions, [kit, mailKit, imageKit]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8')), productionConfig);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('Kit and legacy deploy configs preserve settings and isolate their functions/hooks.');
