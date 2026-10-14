import { SandboxScriptedFault } from './types';
import { getProviderExecutionProfile } from './profile';

/** Class identity is created only by the server's consumed immutable fault plan.
 * Client fields, provider response strings and generic sandbox defects never qualify. */
export function isTrustedScriptedSandboxFault(error: unknown): error is SandboxScriptedFault {
  if (!(error instanceof SandboxScriptedFault)) return false;
  try {
    const profile = getProviderExecutionProfile();
    return profile.mode === 'sandbox' && profile.projectId === 'urm-app-staging';
  } catch {
    return false;
  }
}
