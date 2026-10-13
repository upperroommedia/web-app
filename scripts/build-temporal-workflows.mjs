import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, 'apps/temporal-worker/package.json'));
const { bundleWorkflowCode } = require('@temporalio/worker');
const bundle = await bundleWorkflowCode({
  workflowsPath: resolve(root, 'apps/temporal-worker/src/workflows/index.ts'),
});
const destination = resolve(root, 'apps/temporal-worker/lib/workflow-bundle.js');
await mkdir(resolve(root, 'apps/temporal-worker/lib'), { recursive: true });
await writeFile(destination, bundle.code);
console.log('Temporal workflow bundle built.');
