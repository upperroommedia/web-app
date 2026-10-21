import {createRequire} from 'node:module';
import {resolve} from 'node:path';
/** Called only inside the verified runtime loader by the release adapter. */
export function loadNativeReleaseApplication(runtimeRoot,purpose){
    if (process[Symbol.for('ts-node.register.instance')]) throw new Error('RELEASE_COMPILER_ALREADY_ACTIVE');
    const runtimeRequire = createRequire(resolve(runtimeRoot, 'package.json'));
    const service = runtimeRequire('ts-node').register({ skipProject: true, transpileOnly: true, preferTsExts: true,
      compilerOptions: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, moduleResolution: 'node' } });
    try {
      const workerRequire = createRequire(resolve(runtimeRoot, 'apps/temporal-worker/package.json'));
      return { ...(['controls-promotion','search-promotion'].includes(purpose)?{...workerRequire('@temporalio/worker'),workflowsPath:resolve(runtimeRoot,'apps/temporal-worker/src/workflows/index.ts')}:{}),...workerRequire('@temporalio/client'),
        ...workerRequire(resolve(runtimeRoot, 'apps/temporal-worker/src/runtime/serverless-release-readiness.ts')) };
    } finally {
      service.enabled(false);
      // ts-node leaves this marker after disabling its hooks. Release only the
      // service created here; an unrelated compiler must remain fenced.
      const key=Symbol.for('ts-node.register.instance');
      if(process[key]===service)delete process[key];
    }
}
