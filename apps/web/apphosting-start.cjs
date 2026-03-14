const fs = require('node:fs');
const path = require('node:path');

const candidates = [
  '.next/standalone/apps/web/server.js',
  'apps/web/.next/standalone/apps/web/server.js',
  'apps/web/server.js',
  '.next/standalone/server.js',
  'server.js',
];

const resolved = candidates
  .map((candidate) => path.join(process.cwd(), candidate))
  .find((candidate) => fs.existsSync(candidate));

if (!resolved) {
  console.error('Unable to locate App Hosting standalone server entrypoint.');
  console.error(
    JSON.stringify(
      {
        cwd: process.cwd(),
        candidates,
      },
      null,
      2
    )
  );
  process.exit(1);
}

require(resolved);
