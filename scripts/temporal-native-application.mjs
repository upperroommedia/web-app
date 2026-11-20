import { createRequire } from 'node:module';
import { resolve } from 'node:path';
/** Called only inside the verified runtime loader by the release adapter. */
export function loadNativeReleaseApplication(runtimeRoot) {
  if (process[Symbol.for('ts-node.register.instance')]) throw new Error('RELEASE_COMPILER_ALREADY_ACTIVE');
  const runtimeRequire = createRequire(resolve(runtimeRoot, 'package.json'));
  const service = runtimeRequire('ts-node').register({
    skipProject: true,
    transpileOnly: true,
    preferTsExts: true,
    compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' },
  });
  try {
    const workerRequire = createRequire(resolve(runtimeRoot, 'apps/temporal-worker/package.json'));
    return {
      ...workerRequire('@temporalio/common/lib/proto-utils'),
      ...workerRequire(resolve(runtimeRoot, 'apps/temporal-worker/src/runtime/media-recovery-work.ts')),
      ...workerRequire('@temporalio/client'),
      ...workerRequire(resolve(runtimeRoot, 'apps/temporal-worker/src/runtime/media-recovery-collector.ts')),
      ...workerRequire(resolve(runtimeRoot, 'apps/temporal-worker/src/runtime/media-recovery-idle-startup.ts')),
      ...workerRequire(resolve(runtimeRoot, 'apps/temporal-worker/src/runtime/restored-media-collector.ts')),
      ...workerRequire(resolve(runtimeRoot, 'apps/temporal-worker/src/runtime/serverless-release-readiness.ts')),
      ...workerRequire(resolve(runtimeRoot, 'apps/temporal-worker/src/runtime/worker-wake-history.ts')),
      ...workerRequire(resolve(runtimeRoot, 'apps/temporal-worker/src/runtime/worker-wake-start.ts')),
    };
  } finally {
    service.enabled(false);
    // ts-node leaves this marker after disabling its hooks. Release only the
    // service created here; an unrelated compiler must remain fenced.
    const key = Symbol.for('ts-node.register.instance');
    if (process[key] === service) delete process[key];
  }
}
