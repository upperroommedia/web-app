/** Explicit scope proof before including staging search in environment materialization. */
export function assertStagingSearchEnvironmentRelease({ project, release, control, commit }) {
  const initial =
    release?.mode === 'initial-cutover' && release.domains?.length === 1 && release.domains[0] === 'search';
  const upgrade =
    release?.mode === 'durable-upgrade' &&
    release.domains?.includes('search') &&
    release.domains.every((domain) => control?.domains?.[domain]?.owner === 'temporal');
  if (
    project !== 'urm-app-staging' ||
    release?.projectId !== project ||
    release.environment !== 'staging' ||
    (!initial && !upgrade) ||
    release.compatibilityCommit !== commit ||
    release.releaseId !== control?.releaseId ||
    !['legacy', 'temporal'].includes(control.domains?.search?.owner)
  )
    throw new Error('Staging search environment opt-in requires the exact active reviewed search-only release');
}
