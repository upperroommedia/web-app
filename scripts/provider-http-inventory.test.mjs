import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../functions/src');
const facade = resolve(root, 'providerSandbox/http');
// Deliberate finite review surface, including dynamic URLs and retained legacy entrypoints.
const providerFiles = [
  'Scrapers/populateImagesHelper.ts',
  'Scrapers/populateListsHelper.ts',
  'Scrapers/populateSpeakersHelper.ts',
  'Scrapers/populateTopicsHelper.ts',
  'Scrapers/repopulateListFromSpeakerItems.ts',
  'backfillHolyWeekLists.ts',
  'computeMetadataForImage.ts',
  'createNewSubsplashList.ts',
  'deleteFromSubsplash.ts',
  'deleteImage_not_used.ts',
  'editSubsplashList.ts',
  'editSubsplashSermon.ts',
  'helpers/addToListHelpers.ts',
  'helpers/deleteLogicalListChain.ts',
  'helpers/listOverflowChain.ts',
  'helpers/publishedListDrift.ts',
  'helpers/seriesHelpers.ts',
  'helpers/sermonDeletionDestinations.ts',
  'helpers/speakerDeletionMirrors.ts',
  'helpers/subsplashImageRefs.ts',
  'helpers/subsplashMediaItems.ts',
  'helpers/updateSubsplashTagsHelper.ts',
  'old_addToList.ts',
  'removeFromList.ts',
  'reorderListItems.ts',
  'speakers/speakerMutations.ts',
  'temporal/images/activities.ts',
  'temporal/publishing/audioReplacement.ts',
  'temporal/publishing/bindingReconciliation.ts',
  'temporal/publishing/cancellation.ts',
  'temporal/publishing/criticalRepair.ts',
  'temporal/publishing/entityMutations.ts',
  'temporal/publishing/firebaseDependencies.ts',
  'temporal/publishing/mutationTargetProof.ts',
  'temporal/publishing/providerDeletion.ts',
  'temporal/publishing/receiptResolution.ts',
  'subsplashUtils.ts',
  'soundcloudSecrets.ts',
  'soundcloudClient.ts',
  'uploadToSubsplash.ts',
  'handleImageUpload.ts',
  'temporal/publishing/providerReadiness.ts',
];
const delegatedFiles = new Set([
  'subsplashUtils.ts',
  'soundcloudSecrets.ts',
  'soundcloudClient.ts',
  'uploadToSubsplash.ts',
  'handleImageUpload.ts',
  'temporal/publishing/providerReadiness.ts',
]);
const unrelatedAxiosFiles = new Set(['Dolby/getDolbyToken.ts', 'Dolby/transcodeAudio.ts']);
const rawTransportExceptions = new Set(['providerRelay.ts', 'providerSandbox/http.ts']);
const axiosCallableNames = new Set([
  'default',
  'request',
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'create',
]);
function inspectSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const direct = [],
    routed = [],
    aliases = new Set();
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text,
        clause = node.importClause;
      if (module === 'axios' && clause && !clause.isTypeOnly) {
        if (clause.name) direct.push('raw default Axios');
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) direct.push('raw namespace Axios');
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const spec of clause.namedBindings.elements)
            if (!spec.isTypeOnly && axiosCallableNames.has(spec.propertyName?.text ?? spec.name.text))
              direct.push('raw callable Axios import');
      }
      if (module.startsWith('.') && resolve(dirname(resolve(root, file)), module) === facade) {
        routed.push(module);
        if (clause?.name) aliases.add(clause.name.text);
      }
    }
    if (ts.isBindingElement(node) && node.propertyName?.getText(source) === 'default' && ts.isIdentifier(node.name))
      aliases.add(node.name.text);
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (
        first &&
        ts.isStringLiteral(first) &&
        first.text === 'axios' &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        direct.push('raw dynamic/required Axios');
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        first &&
        ts.isStringLiteral(first) &&
        first.text.startsWith('.') &&
        resolve(dirname(resolve(root, file)), first.text) === facade
      )
        routed.push(first.text);
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        aliases.has(node.expression.expression.text) &&
        node.expression.name.text === 'create'
      )
        direct.push('unfenced Axios instance creation');
      if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch')
        direct.push('native fetch requires explicit sandbox transport review');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { text, direct, routed };
}
const inspect = (file) => inspectSource(file, readFileSync(resolve(root, file), 'utf8'));
function files(directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(directory, entry.name))
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [relative(root, resolve(directory, entry.name)).replaceAll('\\', '/')]
      : []
  );
}
test('finite provider HTTP surface uses the explicit sandbox facade, retaining real Axios named errors/types', () => {
  assert.equal(new Set(providerFiles).size, providerFiles.length);
  const violations = [];
  for (const file of providerFiles) {
    const { direct, routed } = inspect(file);
    if (!routed.length || direct.length) violations.push({ file, direct, routed });
  }
  assert.deepEqual(violations, []);
});
test('unreviewed Axios transports cannot silently bypass the finite provider inventory', () => {
  const missing = [];
  for (const file of files()) {
    if (file.startsWith('test/') || file.startsWith('providerSandbox/') || rawTransportExceptions.has(file)) continue;
    const result = inspect(file);
    if (
      result.direct.some((value) => value.includes('Axios')) &&
      !providerFiles.includes(file) &&
      !unrelatedAxiosFiles.has(file)
    )
      missing.push(file);
  }
  assert.deepEqual(missing, []);
});

test('owned migration routes all thirty-six reviewed HTTP files through the facade', () => {
  const owned = providerFiles.filter((file) => !delegatedFiles.has(file));
  assert.equal(owned.length, 36);
  for (const file of owned) {
    const result = inspect(file);
    assert.deepEqual(result.direct, [], file);
    assert.ok(result.routed.length, file);
  }
});
test('inventory AST accepts named Axios errors/types and rejects callable aliases and unfenced clients', () => {
  const file = 'sample.ts';
  const valid = inspectSource(
    file,
    "import axios from './providerSandbox/http'; import {AxiosError,isAxiosError,type AxiosRequestConfig} from 'axios'; axios.get(url)"
  );
  assert.deepEqual(valid.direct, []);
  assert.equal(valid.routed.length, 1);
  for (const source of [
    "import client from 'axios'; client(url)",
    "import {get as providerGet} from 'axios'",
    "import * as client from 'axios'",
    "const client=await import('axios')",
    "const client=require('axios')",
    "import client from './providerSandbox/http';client.create()",
    "const {default:client}=await import('./providerSandbox/http');client.create()",
    'fetch(providerUrl)',
  ])
    assert.ok(inspectSource(file, source).direct.length, source);
  assert.equal(
    inspectSource(file, "const {default:client}=await import('./providerSandbox/http');client.get(url)").routed.length,
    1
  );
});
