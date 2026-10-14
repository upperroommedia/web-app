import {
  isProviderSandboxStatus,
  SIMULATION_SCENARIO_LABELS,
  stagingPasswordResetMessage,
} from '../../utils/providerSimulation';

describe('server-authoritative provider mode', () => {
  it('blocks password reset only for the configured staging project', () => {
    expect(stagingPasswordResetMessage('urm-app-staging')).toContain('unavailable on staging');
    expect(stagingPasswordResetMessage('urm-app')).toBeUndefined();
  });
  const ready = {
    mode: 'sandbox',
    ready: true,
    catalogReady: true,
    profileId: 'urm-app-staging-publishing-v1',
    version: 1,
    scenarioSelectionAllowed: true,
  };
  it('requires a validated exact staging profile and ready catalog', () => {
    expect(isProviderSandboxStatus(ready)).toBe(true);
    for (const patch of [
      { catalogReady: false },
      { ready: false },
      { profileId: 'production' },
      { version: 2 },
      { scenarioSelectionAllowed: 'true' },
    ]) {
      expect(isProviderSandboxStatus({ ...ready, ...patch })).toBe(false);
    }
  });
  it('accepts safe blocked and real production responses without enabling scenarios', () => {
    expect(
      isProviderSandboxStatus({
        mode: 'blocked',
        ready: false,
        catalogReady: false,
        scenarioSelectionAllowed: false,
        reason: 'catalog-not-ready',
      })
    ).toBe(true);
    expect(
      isProviderSandboxStatus({ mode: 'live', ready: true, catalogReady: false, scenarioSelectionAllowed: false })
    ).toBe(true);
    expect(
      isProviderSandboxStatus({ mode: 'live', ready: true, catalogReady: false, scenarioSelectionAllowed: true })
    ).toBe(false);
  });
  it('names the exact supported server scenarios', () => {
    expect(Object.keys(SIMULATION_SCENARIO_LABELS)).toEqual([
      'success',
      'delayed-processing',
      'transient-failure',
      'permanent-failure',
      'commit-then-lost-response',
    ]);
  });
});
