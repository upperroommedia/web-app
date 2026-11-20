// Test-only source routing: workspace packages normally export generated JS.
// These native tests must execute the checked-out TS, never stale adjacent/lib JS.
const Module = require('node:module');
const { resolve } = require('node:path');
const { statSync } = require('node:fs');
const root = resolve(__dirname, '../../..');
const original = Module._resolveFilename;
Module._resolveFilename = function (specifier, parent, ...rest) {
  const match = /^@upperroom\/(shared|contracts|orchestration)\/(.+)$/.exec(specifier);
  if (match) {
    const [, pkg, suffix] = match;
    if (suffix.includes('..') || suffix.startsWith('/')) throw new Error('Workspace source reference denied');
    const base = resolve(root, 'packages', pkg, pkg === 'orchestration' ? 'src' : '', suffix);
    for (const path of [base.endsWith('.json') ? base : `${base}.ts`, resolve(base, 'index.ts')]) {
      try {
        if (statSync(path).isFile()) return path;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      }
    }
    throw new Error('Current workspace source unavailable');
  }
  return Reflect.apply(original, this, [specifier, parent, ...rest]);
};
