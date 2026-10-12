import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectDevEmulatorConfig, writeDevEmulatorConfig } from './write-dev-emulator-config.mjs';
import { selectMailEmulatorConfig, writeMailEmulatorConfig } from './write-mail-emulator-config.mjs';

const core = { source: 'functions-core', codebase: 'core', predeploy: ['build'] };
const email = { kit: 'firestore-send-email', source: 'function-kits/email', instances: { production: 'production-email-config' } };
const algolia = { kit: 'firestore-algolia-search', source: 'function-kits/search', instances: { production: 'production-search-config' } };
const input = { functions: [core, email, algolia], extensions: { legacy: 'remote-extension' },
  emulators: { functions: { port: 5001 }, firestore: { port: 8081 } }, firestore: { rules: 'firestore.rules' } };
const snapshot = structuredClone(input);
const dev = selectDevEmulatorConfig(input);
assert.deepEqual(dev.functions, [core]);
assert.equal('extensions' in dev, false);
assert.deepEqual(dev.emulators, input.emulators);
assert.deepEqual(dev.firestore, input.firestore);
assert.deepEqual(selectDevEmulatorConfig({ functions: core }).functions, [core]);
assert.deepEqual(selectDevEmulatorConfig({}).functions, []);
assert.throws(() => selectMailEmulatorConfig({ functions: [core] }), /does not register/);
assert.deepEqual(selectMailEmulatorConfig({ functions: email }).functions[0].instances,
  { 'firestore-send-email': '.firebase/email-kit-config' });
assert.deepEqual(input, snapshot, 'selection must not mutate deployment settings');

const root = mkdtempSync(join(tmpdir(), 'firebase-dev-config-'));
try {
  writeFileSync(join(root, 'firebase.json'), JSON.stringify(input));
  assert.deepEqual(JSON.parse(readFileSync(writeDevEmulatorConfig({ root }), 'utf8')), dev);
  assert.throws(() => writeMailEmulatorConfig({ root }), /Missing built email kit/);
  assert.equal(existsSync(join(root, 'firebase.mail.json')), false);
  const original = join(root, email.source);
  mkdirSync(join(original, 'lib'), { recursive: true });
  mkdirSync(join(original, 'node_modules'));
  writeFileSync(join(original, 'package.json'), JSON.stringify({ main: 'lib/index.js' }));
  writeFileSync(join(original, 'lib/index.js'), '// built email runtime');
  writeFileSync(join(original, '.env.production'), 'SMTP_PASSWORD=production-secret-reference\n');
  writeFileSync(join(original, '.secret.local'), 'SMTP_PASSWORD=existing-private-value\n');
  const mailFile = writeMailEmulatorConfig({ root });
  const mail = JSON.parse(readFileSync(mailFile, 'utf8'));
  assert.equal('extensions' in mail, false);
  assert.deepEqual(mail.functions.map(entry => entry.kit ?? entry.codebase), ['core', 'firestore-send-email']);
  const source = join(root, mail.functions[1].source);
  const instance = join(root, mail.functions[1].instances['firestore-send-email']);
  assert.match(readFileSync(join(instance, '.env.local'), 'utf8'), /^TESTING=true$/m);
  assert.equal(readFileSync(join(source, '.secret.local'), 'utf8'), 'SMTP_PASSWORD=local-emulator-placeholder\n');
  assert.deepEqual(readdirSync(source).sort(), ['.secret.local', 'lib', 'node_modules', 'package.json']);
  assert.deepEqual(readdirSync(instance), ['.env.local']);
  assert.equal(realpathSync(join(source, 'node_modules')), realpathSync(join(original, 'node_modules')));
  assert.equal(readFileSync(join(original, '.secret.local'), 'utf8'), 'SMTP_PASSWORD=existing-private-value\n');
  writeFileSync(join(instance, '.env.production'), 'unsafe=stale');
  writeFileSync(join(source, 'lib/stale.js'), '// removed from original');
  writeMailEmulatorConfig({ root });
  assert.equal(existsSync(join(instance, '.env.production')), false, 'regeneration removes stale overrides');
  assert.equal(existsSync(join(source, 'lib/stale.js')), false, 'regeneration removes stale built runtime');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8')), input);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('Default/mail emulator isolation, safe local secrets, and regeneration checks passed.');
