// Current source only, never generated JS. Owned local OS protocol fixture.
const { resolve, dirname } = require('node:path');
const { readFileSync } = require('node:fs');
const Module = require('node:module');
require('./current-workspace-source.cjs');
require('ts-node').register({
  preferTsExts: true,
  skipProject: true,
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
});
const originalLoad = Module._load;
Module._load = function (specifier, parent, main) {
  if (String(specifier).includes('firebaseAdmin') || String(specifier).includes('processYouTubeUrl')) {
    process.send?.({ fixture: 'forbidden-early-initialization' });
    throw Error('CONTROLLED_FORBIDDEN_INITIALIZATION');
  }
  return originalLoad.call(this, specifier, parent, main);
};
const path = resolve(__dirname, '../../../apps/process-audio/src/temporal/hetzner-acquisition-helper.ts');
const source = require('typescript').transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: {
    module: require('typescript').ModuleKind.CommonJS,
    target: require('typescript').ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const entry = new Module(path);
entry.filename = path;
entry.paths = Module._nodeModulePaths(dirname(path));
process.mainModule = entry;
Module._cache[path] = entry;
entry._compile(source, path);
process.send?.({ fixture: 'inert-ready', installed: process.listenerCount('message') === 1 });
