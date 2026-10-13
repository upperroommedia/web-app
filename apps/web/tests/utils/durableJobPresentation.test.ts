import type { DurableJob } from '@upperroom/contracts/temporal';
import {
  JOB_STATE_LABELS,
  jobStateLabel,
  stoppedRepairMessage,
  measuredStepPercent,
  entityHref,
  hasUnsentProviderGraphChange,
  hasUnresolvedProviderMutation,
} from '../../utils/durableJobPresentation';

describe('honest job presentation', () => {
  it('uses only a complete certified stop result and never calls it successful deletion', () => {
    const stopped = {
      kind: 'sermon.delete',
      state: 'cancelled',
      result: { mode: 'partial_stop', providerEffects: 'partial', contentPreserved: true },
    } as DurableJob;
    expect(jobStateLabel(stopped)).toBe('Stopped');
    expect(stoppedRepairMessage(stopped)).toContain('Remaining content was kept');
    expect(jobStateLabel({ ...stopped, state: 'cancel_requested' })).toBe('Stopping');
    expect(jobStateLabel({ ...stopped, state: 'succeeded' })).toBe('Stopped');
    for (const result of [
      { mode: 'partial_stop', providerEffects: 'partial' },
      { mode: 'partial_stop', providerEffects: 'unknown', contentPreserved: true },
      { providerEffects: 'not_started', contentPreserved: true },
    ]) {
      expect(stoppedRepairMessage({ ...stopped, result })).toBeUndefined();
      expect(jobStateLabel({ ...stopped, result })).toBe('Cancelled');
    }
  });

  it('keeps a proved-unsent graph change separate from a quarantined request even when projected on a step', () => {
    const job = { steps: [{ error: { code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT' } }] } as DurableJob;
    expect(hasUnsentProviderGraphChange(job)).toBe(true);
    expect(hasUnresolvedProviderMutation(job)).toBe(false);
    expect(
      hasUnsentProviderGraphChange({
        steps: [],
        result: { code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT' },
      } as unknown as DurableJob)
    ).toBe(true);
  });
  it('does not invent progress for unknown totals', () => {
    expect(measuredStepPercent({ id: 'a', label: 'Publishing', state: 'running', attempt: 1 })).toBeUndefined();
    expect(
      measuredStepPercent({
        id: 'a',
        label: 'Publishing',
        state: 'running',
        attempt: 1,
        progress: { completed: 3, total: 0, unit: 'items' },
      })
    ).toBeUndefined();
  });
  it('labels cancellation and remote uncertainty separately from terminal outcomes', () => {
    expect(JOB_STATE_LABELS.cancel_requested).toBe('Cancellation requested');
    expect(JOB_STATE_LABELS.reconciling).toBe('Checking the destination');
    expect(JOB_STATE_LABELS.cancelled).toBe('Cancelled');
  });
  it('measures only the reported step and safely links entities', () => {
    expect(
      measuredStepPercent({
        id: 'a',
        label: 'Transfer',
        state: 'running',
        attempt: 1,
        progress: { completed: 43, total: 100, unit: 'bytes' },
      })
    ).toBe(43);
    expect(entityHref({ type: 'sermon', id: 'a/b' })).toBe('/admin/sermons/a%2Fb');
    expect(entityHref({ type: 'mail', id: 'hidden' })).toBeUndefined();
  });
});
