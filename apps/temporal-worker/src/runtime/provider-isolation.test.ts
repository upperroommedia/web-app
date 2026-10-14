let mockActualProject = 'urm-app';
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: mockActualProject } }) },
}));
import { assertLiveProviderMutationProject, isPrivateProviderMutationSimulation } from './provider-isolation';
test('shared staging provider accounts cannot mutate or claim isolated ownership', () => {
  expect(() => assertLiveProviderMutationProject('urm-app-staging')).toThrow();
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

test('a selected sandbox profile authorizes only its actual project', () => {
  const previous = process.env.STAGING_PROVIDER_MODE;
  try {
    mockActualProject = 'urm-app-staging';
    process.env.STAGING_PROVIDER_MODE = 'sandbox';
    expect(() => assertLiveProviderMutationProject('urm-app-staging')).not.toThrow();
    expect(() => assertLiveProviderMutationProject('urm-app')).toThrow();
    mockActualProject = 'unreviewed-project';
    expect(() => assertLiveProviderMutationProject('unreviewed-project')).toThrow();
  } finally {
    mockActualProject = 'urm-app';
    if (previous === undefined) delete process.env.STAGING_PROVIDER_MODE;
    else process.env.STAGING_PROVIDER_MODE = previous;
  }
});
