import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pinReleaseCheckouts } from './temporal-release-runtime.mjs';
export const ORIGINAL_OPERATOR_COMMIT = '2cefbc16d24ada659e06689c931c0167139d40ab';
const need = (v, code) => {
  if (!v) throw Object.assign(new Error(code), { code });
};
export function validateRecoveryOperatorBindings(current, origin, target, isDescendant) {
  need(
    origin.operatorCommit === ORIGINAL_OPERATOR_COMMIT &&
      origin.runtimeCommit === target.compatibilityCommit &&
      target.compatibilityCommit === ORIGINAL_OPERATOR_COMMIT,
    'EXACT_ORIGINAL_OPERATOR_AND_RUNTIME_REQUIRED'
  );
  need(
    current.runtimeRoot === origin.runtimeRoot &&
      current.runtimeCommit === origin.runtimeCommit &&
      current.operatorCommit !== ORIGINAL_OPERATOR_COMMIT &&
      isDescendant === true,
    'COMMITTED_DESCENDANT_REPORT_OPERATOR_REQUIRED'
  );
  need(
    /^[a-f0-9]{40}$/.test(current.operatorCommit) &&
      /^[a-f0-9]{64}$/.test(current.operatorClosureDigest) &&
      /^[a-f0-9]{64}$/.test(origin.operatorClosureDigest),
    'COMMITTED_OPERATOR_CLOSURE_REQUIRED'
  );
  return {
    schemaVersion: 1,
    operatorCommit: current.operatorCommit,
    operatorClosureDigest: current.operatorClosureDigest,
    originalOperatorCommit: origin.operatorCommit,
    originalOperatorClosureDigest: origin.operatorClosureDigest,
    runtimeCommit: origin.runtimeCommit,
    runtimeRoot: origin.runtimeRoot,
  };
}

export function pinRecoveryOperatorBindings(currentRoot, originOperatorRoot, runtimeRoot, target) {
  const current = pinReleaseCheckouts(currentRoot, realpathSync(runtimeRoot), target);
  const origin = pinReleaseCheckouts(realpathSync(originOperatorRoot), current.runtimeRoot, target);
  let ancestor = false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ORIGINAL_OPERATOR_COMMIT, current.operatorCommit], {
      cwd: currentRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ancestor = true;
  } catch {}
  return { current, origin, operatorBinding: validateRecoveryOperatorBindings(current, origin, target, ancestor) };
}
