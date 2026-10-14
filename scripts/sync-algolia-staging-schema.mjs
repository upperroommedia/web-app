import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = new URL('../packages/contracts/staging-search.json', import.meta.url);
const destination = new URL('../function-kits/firestore-algolia-search/src/staging-search.json', import.meta.url);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !['--check', '--write'].includes(args[0]))) {
  throw new Error('Use --check (default) or --write');
}
const canonical = readFileSync(source, 'utf8');
if (args[0] === '--write') writeFileSync(destination, canonical);
else if (readFileSync(destination, 'utf8') !== canonical)
  throw new Error('Staging schema mirror differs; run with --write and review both files');

const protocol = new URL('../packages/contracts/stagingSearchReadiness.ts', import.meta.url);
const stable = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]])
        )
      : v
  );
const digest = createHash('sha256')
  .update(stable(JSON.parse(canonical)))
  .digest('hex');
const previous = readFileSync(protocol, 'utf8');
if (!/STAGING_SEARCH_SCHEMA_SHA256 = '[a-f0-9]{64}'/.test(previous))
  throw new Error('Readiness protocol schema hash declaration is missing');
const updated = previous.replace(
  /STAGING_SEARCH_SCHEMA_SHA256 = '[a-f0-9]{64}'/,
  `STAGING_SEARCH_SCHEMA_SHA256 = '${digest}'`
);
if (!previous.includes(`STAGING_SEARCH_SCHEMA_SHA256 = '${digest}'`)) {
  if (args[0] === '--write') writeFileSync(protocol, updated);
  else throw new Error('Staging readiness schema hash differs; run with --write and review the protocol');
}
