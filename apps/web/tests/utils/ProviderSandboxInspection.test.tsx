import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderSandboxJobInspection } from '@upperroom/contracts/providerSandbox';
import ProviderSandboxInspection from '../../components/jobs/ProviderSandboxInspection';
import { isProviderSandboxJobInspection } from '../../utils/providerSimulation';
const resource = {
  provider: 'soundcloud' as const,
  family: 'tracks',
  id: 'sandbox-track-1',
  title: 'Owned test recording',
  deleted: false,
};
const inspection: ProviderSandboxJobInspection = {
  profileId: 'urm-app-staging-publishing-v1',
  jobId: 'job-test',
  providerExecution: {
    mode: 'sandbox',
    profileId: 'urm-app-staging-publishing-v1',
    version: 1,
    scenario: 'commit-then-lost-response',
  },
  observedAtMillis: 1,
  requests: [
    {
      provider: 'soundcloud',
      method: 'POST',
      atMillis: 1,
      outcome: 'committed-response-lost',
      fault: 'commit-then-lost-response',
      resourceRefs: [resource],
    },
  ],
  resources: [resource],
  truncated: { requests: false, resources: false },
};
describe('read-only simulated destination evidence', () => {
  it('shows committed resources and response loss without implying approval', () => {
    expect(isProviderSandboxJobInspection(inspection)).toBe(true);
    const html = renderToStaticMarkup(<ProviderSandboxInspection inspection={inspection} />);
    expect(html).toContain('sandbox-track-1');
    expect(html).toContain('committed-response-lost');
    expect(html).toContain('does not approve a result or complete the task');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });
  it('warns about incomplete data without implying absence or uniqueness', () => {
    const html = renderToStaticMarkup(
      <ProviderSandboxInspection
        inspection={{ ...inspection, resources: [], truncated: { requests: true, resources: true } }}
      />
    );
    expect(html).toContain('Do not infer that an item is absent or unique');
    expect(html).toContain('does not prove that no provider effect occurred');
  });
  it('rejects wrong profile, malformed times, excessive rows and unsafe titles', () => {
    for (const patch of [
      { profileId: 'production' },
      { observedAtMillis: NaN },
      { requests: Array(101).fill(inspection.requests[0]) },
      { resources: [{ ...resource, title: 'https://example.com/private' }] },
      { resources: [{ ...resource, readyAtMillis: Infinity }] },
      { requests: [{ ...inspection.requests[0], resourceRefs: Array(201).fill(resource) }] },
    ])
      expect(isProviderSandboxJobInspection({ ...inspection, ...patch })).toBe(false);
  });
});
