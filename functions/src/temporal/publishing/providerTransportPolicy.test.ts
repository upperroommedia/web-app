jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({ __esModule: true, default: { app: jest.fn() } }));
import {
  runDurablePublishingOperation,
  beginProviderMutationPlan,
  runPublishingProviderMutation,
  isPublishingProviderCreateForbidden,
  prepareProviderMutationPlanCommit,
} from './durableOperationContext';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { assertProviderMutationTransportAllowed } from './providerTransportPolicy';
describe('actual provider transport isolation', () => {
  it('blocks both staging vendor transports even when private test simulation is enabled', () => {
    (firebaseAdmin.app as jest.Mock).mockReturnValue({ options: { projectId: 'urm-app-staging' } });
    const keys = ['TEMPORAL_PROVIDER_MUTATION_SIMULATION', 'FIRESTORE_EMULATOR_HOST', 'NODE_ENV'] as const;
    const previous = keys.map((key) => process.env[key]);
    Object.assign(process.env, {
      TEMPORAL_PROVIDER_MUTATION_SIMULATION: 'true',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8089',
      NODE_ENV: 'test',
    });
    try {
      for (const provider of ['subsplash', 'soundcloud'] as const)
        expect(() => assertProviderMutationTransportAllowed(provider)).toThrow('verified isolated provider account');
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });
  it('preserves explicitly configured production transport authority', () => {
    (firebaseAdmin.app as jest.Mock).mockReturnValue({ options: { projectId: 'urm-app' } });
    expect(() => assertProviderMutationTransportAllowed('subsplash')).not.toThrow();
  });
});

describe('canonical-only cleanup authority', () => {
  it('rejects new provider effects even with production credentials while allowing fenced final settlement', async () => {
    (firebaseAdmin.app as jest.Mock).mockReturnValue({ options: { projectId: 'urm-app' } });
    const begin = jest.fn(),
      send = jest.fn(),
      settle = jest.fn().mockResolvedValue({ alreadyCommitted: false, commit: jest.fn() });
    await runDurablePublishingOperation(
      'job-cleanup',
      async () => {
        expect(isPublishingProviderCreateForbidden()).toBe(true);
        for (const provider of ['subsplash', 'soundcloud'] as const)
          expect(() => assertProviderMutationTransportAllowed(provider)).toThrow('Factual cleanup cannot mutate');
        await expect(beginProviderMutationPlan({ operation: 'cleanup', resources: [] })).rejects.toThrow(
          'CONTEXT_REQUIRED'
        );
        await expect(
          runPublishingProviderMutation({
            operation: 'cleanup',
            step: 'delete',
            method: 'DELETE',
            target: { provider: 'subsplash', account: 'app:9XTSHD', resourceType: 'media', resourceId: 'media' },
            payload: {},
            send,
          })
        ).rejects.toThrow('CONTEXT_REQUIRED');
        await prepareProviderMutationPlanCommit({} as never, { operation: 'cleanup' });
      },
      undefined,
      {
        purpose: 'factual_cleanup',
        beginProviderMutationPlan: begin,
        runPublishingProviderMutation: send,
        prepareProviderMutationPlanCommit: settle,
      }
    );
    expect(begin).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
