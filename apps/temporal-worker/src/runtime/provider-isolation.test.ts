import { assertLiveProviderMutationProject, isPrivateProviderMutationSimulation } from './provider-isolation';
test('shared staging provider accounts cannot mutate or claim isolated ownership', () => {
  expect(() => assertLiveProviderMutationProject('urm-app-staging')).toThrow('Isolated provider accounts are required');
  expect(() => assertLiveProviderMutationProject('unreviewed-project')).toThrow();
  expect(() => assertLiveProviderMutationProject('urm-app')).not.toThrow();
});
test('private emulator simulation never grants live provider transport authority', () => {
  const prior = {
    node: process.env.NODE_ENV,
    simulation: process.env.TEMPORAL_PROVIDER_MUTATION_SIMULATION,
    host: process.env.FIRESTORE_EMULATOR_HOST,
  };
  try {
    process.env.NODE_ENV = 'test';
    process.env.TEMPORAL_PROVIDER_MUTATION_SIMULATION = 'true';
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:18081';
    expect(isPrivateProviderMutationSimulation()).toBe(true);
    expect(() => assertLiveProviderMutationProject('urm-app-staging')).toThrow();
    process.env.NODE_ENV = 'production';
    expect(isPrivateProviderMutationSimulation()).toBe(false);
    process.env.NODE_ENV = 'test';
    process.env.FIRESTORE_EMULATOR_HOST = 'remote.example:8080';
    expect(isPrivateProviderMutationSimulation()).toBe(false);
  } finally {
    for (const [key, value] of Object.entries({
      NODE_ENV: prior.node,
      TEMPORAL_PROVIDER_MUTATION_SIMULATION: prior.simulation,
      FIRESTORE_EMULATOR_HOST: prior.host,
    }))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
