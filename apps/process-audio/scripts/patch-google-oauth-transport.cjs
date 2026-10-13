'use strict';

const { readdirSync, existsSync, readFileSync, writeFileSync, realpathSync } = require('node:fs');
const { join, resolve } = require('node:path');

// Token responses from the Hetzner egress path occasionally truncate compressed
// bodies. Restrict this workaround to token exchange, across every installed
// SDK copy. Fail closed when a dependency changes the exchange implementation.
function patchTokenModule(file, kind) {
  const source = readFileSync(file, 'utf8');
  if (source.includes("'Accept-Encoding': 'identity'")) return false;
  const needle =
    kind === 'legacy' ? "headers: { 'Content-Type': 'application/x-www-form-urlencoded' }," : "responseType: 'json',";
  const replacement =
    kind === 'legacy'
      ? "headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Encoding': 'identity' },"
      : "headers: { 'Accept-Encoding': 'identity' },\n        responseType: 'json',";
  if (source.split(needle).length !== 2) throw new Error(`Unsupported Google OAuth token transport: ${file}`);
  writeFileSync(file, source.replace(needle, replacement));
  return true;
}

function patchInstalledTokenTransports(root) {
  const seen = new Set();
  const found = [];
  function walk(directory) {
    const real = realpathSync(directory);
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of readdirSync(real, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(real, entry.name);
      if (!existsSync(path)) continue;
      if (entry.name === 'google-auth-library') {
        const current = join(path, 'build/src/gtoken/getToken.js');
        if (existsSync(current)) found.push({ file: realpathSync(current), kind: 'current' });
      }
      if (entry.name === 'gtoken') {
        const legacy = join(path, 'build/src/index.js');
        if (existsSync(legacy)) found.push({ file: realpathSync(legacy), kind: 'legacy' });
      }
      // Dependency layouts are hoisted or pnpm's .pnpm/package/node_modules.
      // Do not recursively scan package source or unrelated workspace files.
      if (
        entry.name === 'node_modules' ||
        entry.name === '.pnpm' ||
        entry.name.startsWith('@') ||
        real.endsWith('/.pnpm')
      )
        walk(path);
      else {
        const nested = join(path, 'node_modules');
        if (existsSync(nested)) walk(nested);
      }
    }
  }
  walk(resolve(root));
  const unique = [...new Map(found.map((target) => [target.file, target])).values()];
  if (unique.length === 0) throw new Error('No supported Google OAuth token exchange module is installed.');
  let changed = 0;
  for (const target of unique) if (patchTokenModule(target.file, target.kind)) changed++;
  return { modules: unique.length, changed };
}

if (require.main === module) {
  const result = patchInstalledTokenTransports(process.argv[2] || '/workspace/node_modules');
  console.log(
    `Verified Google OAuth identity encoding in ${result.modules} installed transports (${result.changed} updated).`
  );
}
module.exports = { patchTokenModule, patchInstalledTokenTransports };
