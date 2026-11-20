import { renderToStaticMarkup } from 'react-dom/server';
import type { DurableJob } from '@upperroom/contracts/temporal';
import JobStatusPanel from '../../components/jobs/JobStatusPanel';

let child: DurableJob | undefined;
const identity = { user: { uid: 'admin', isAdmin: () => true } };
jest.mock('../../utils/durableJobs', () => ({ submitDurableCommand: jest.fn() }));
jest.mock('../../hooks/useDurableJobs', () => ({
  useDurableJob: () => ({ job: child, loading: false, stale: false, error: null }),
}));
jest.mock('../../context/user/UserContext', () => ({ __esModule: true, default: () => identity }));

const job = (patch: Partial<DurableJob> = {}): DurableJob => ({
  schemaVersion: 1,
  jobId: 'j1',
  projectId: 'test-project',
  kind: 'sermon.publish',
  entity: { type: 'sermon', id: 's1' },
  workflowId: 'wf1',
  generation: 1,
  revision: 2,
  requestedBy: 'uploader',
  requestId: 'r1',
  state: 'running',
  createdAt: 1,
  updatedAt: 2,
  steps: [{ id: 'publish', label: 'Sending to destination', state: 'running', attempt: 1 }],
  actions: ['cancel'],
  ...patch,
});
describe('accessible truthful job details', () => {
  it('keeps compact Activity navigation admin-only without hiding the user’s status', () => {
    const administrator = identity.user;
    identity.user = { uid: 'uploader', isAdmin: () => false };
    try {
      const html = renderToStaticMarkup(<JobStatusPanel job={job()} compact />);
      expect(html).not.toContain('/admin/activity');
      expect(html).toContain('Sending to destination');
      expect(html).toContain('Request cancellation');
    } finally {
      identity.user = administrator;
    }
  });

  it('claims email capture only for a completed staging receipt with full safe provenance', () => {
    const deliveryTransport = {
      schemaVersion: 1,
      mode: 'capture',
      projectId: 'urm-app-staging',
      profileId: 'urm-app-staging-mail-capture-v1',
      version: 1,
      captureId: 'a'.repeat(64),
      payloadSha256: 'b'.repeat(64),
    };
    const capture = job({
      kind: 'email.deliver',
      projectId: 'urm-app-staging',
      state: 'succeeded',
      result: { deliveryTransport, externalDelivery: false },
    });
    expect(renderToStaticMarkup(<JobStatusPanel job={capture} />)).toContain('No external email was sent');
    for (const patch of [
      { state: 'retrying' as const },
      { state: 'needs_attention' as const },
      { projectId: 'urm-app' },
      { result: { deliveryTransport, externalDelivery: true } },
      { result: { deliveryTransport: { ...deliveryTransport, captureId: undefined }, externalDelivery: false } },
    ]) {
      expect(renderToStaticMarkup(<JobStatusPanel job={{ ...capture, ...patch }} />)).not.toContain(
        'Email captured for staging'
      );
    }
  });
  it('labels simulated history using the recorded server profile and original scenario', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          providerExecution: {
            mode: 'sandbox',
            profileId: 'urm-app-staging-publishing-v1',
            version: 1,
            scenario: 'commit-then-lost-response',
          },
        })}
      />
    );
    expect(html).toContain('Simulated Subsplash / SoundCloud');
    expect(html).toContain('Confirmation lost after saving');
    expect(html).toContain('Retries retain this scenario');
    const live = renderToStaticMarkup(<JobStatusPanel job={job()} />);
    expect(live).not.toContain('Simulated Subsplash / SoundCloud');
  });
  beforeEach(() => {
    child = undefined;
    identity.user = { uid: 'admin', isAdmin: () => true };
  });
  it('uses indeterminate progress when no measured total is available and disables stale commands', () => {
    const html = renderToStaticMarkup(<JobStatusPanel job={job()} stale />);
    expect(html).toContain('aria-label="Sending to destination"');
    expect(html).not.toContain('aria-valuenow');
    expect(html).toContain('Displayed status may be outdated');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Request cancellation/);
  });
  it('shows each confirmed and uncertain destination separately', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'needs_attention',
          destinations: [
            { destination: 'subsplash', state: 'confirmed' },
            { destination: 'soundcloud', state: 'unknown' },
          ],
        })}
      />
    );
    expect(html).toContain('Subsplash: confirmed');
    expect(html).toContain('SoundCloud: unknown');
  });
  it('requires reviewed provider evidence and duplicate acknowledgement to adopt an existing item', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'needs_attention',
          actions: ['resolve'],
          attention: { kind: 'external_result_unknown', message: 'Outcome unknown', receiptId: 'receipt' },
        })}
      />
    );
    expect(html).toContain('Provider log or support ticket reference');
    expect(html).toContain('Review reason');
    expect(html).toContain('may leave a duplicate to clean up');
    expect(html).toContain('Verify and adopt existing item');
    expect(html).not.toContain('Mark absent');
  });
  it('reviews account access using stopped-execution evidence without provider IDs or retry', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          kind: 'role.assign',
          state: 'needs_attention',
          error: { code: 'ACCOUNT_CLAIMS_RECONCILIATION_REQUIRED', message: 'Access uncertain' },
          actions: ['resolve', 'retry', 'resume'],
        })}
      />
    );
    expect(html).toContain('Verify access already applied');
    expect(html).toContain('original execution has stopped');
    expect(html).not.toContain('Existing destination item ID');
    expect(html).not.toContain('Retry failed work');
    expect(html).not.toContain('Resume task');
  });
  it('requires a refreshed intent after an unsent graph change while allowing advertised cancellation', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'needs_attention',
          error: { code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT', message: 'Destination changed', retryable: false },
          attention: { kind: 'external_result_unknown', message: 'Refresh destination', receiptId: 'receipt' },
          actions: ['resolve', 'retry', 'resume', 'cancel'],
        })}
      />
    );
    expect(html).toContain('before any request was sent');
    expect(html).toContain('submit a new task');
    expect(html).toContain('Request cancellation');
    expect(html).not.toContain('Existing destination item ID');
    expect(html).not.toContain('Retry failed work');
    expect(html).not.toContain('Resume task');
    expect(html).not.toContain('original request may still arrive');
  });
  it('keeps unresolved mutable requests paused without replay, cancellation or provider-ID resolution', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'needs_attention',
          error: { code: 'PROVIDER_MUTATION_UNRESOLVED', message: 'Change uncertain', retryable: false },
          attention: { kind: 'external_result_unknown', message: 'Outcome unknown', receiptId: 'receipt' },
          result: { mutationSessionId: 'a'.repeat(64) },
          actions: ['resolve', 'cancel', 'retry', 'resume'],
        })}
      />
    );
    expect(html).toContain('original request may still arrive');
    expect(html).toContain('cancellation cannot finish');
    expect(html).toContain('Provider change review:');
    expect(html).not.toContain('Existing destination item ID');
    expect(html).not.toContain('Request cancellation');
    expect(html).not.toContain('Retry failed work');
    expect(html).not.toContain('Resume task');
  });
  it('quarantines an unrecordable provider result without showing response data or generic repair controls', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'needs_attention',
          error: {
            code: 'PROVIDER_MUTATION_RESULT_REPAIR_REQUIRED',
            message: 'Tracking review required',
            retryable: false,
          },
          result: { mutationSessionId: 'c'.repeat(64), rawResponse: 'secret-vendor-response' },
          attention: { kind: 'external_result_unknown', message: 'Safe review needed', receiptId: 'receipt' },
          actions: ['resolve', 'cancel', 'retry', 'resume'],
        })}
      />
    );
    expect(html).toContain('destination response could not be safely recorded');
    expect(html).toContain('cancellation cannot finish');
    expect(html).not.toContain('secret-vendor-response');
    expect(html).not.toContain('Existing destination item ID');
    expect(html).not.toContain('Retry failed work');
    expect(html).not.toContain('Resume task');
    expect(html).not.toContain('Request cancellation');
  });
  it('recognizes the mutation barrier from a step and restricts its opaque review ID to admins', () => {
    identity.user = { uid: 'uploader', isAdmin: () => false };
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'cancel_requested',
          steps: [
            {
              id: 'cleanup',
              label: 'Reviewing cleanup',
              state: 'failed',
              attempt: 1,
              error: {
                code: 'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
                message: 'Request unresolved',
                retryable: false,
              },
            },
          ],
          result: { mutationSessionId: 'a'.repeat(64) },
          actions: ['cancel', 'resume'],
        })}
      />
    );
    expect(html).toContain('Cancellation requested');
    expect(html).toContain('original request may still arrive');
    expect(html).not.toContain('Provider change review:');
    expect(html).not.toContain('Request cancellation');
    expect(html).not.toContain('Resume task');
  });
  it('allows only an explicit certified repair for the unresolved mutation state', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'needs_attention',
          result: { code: 'PROVIDER_MUTATION_UNRESOLVED', mutationSessionId: 'invalid-or-secret-value' },
          attention: {
            kind: 'remote_drift',
            message: 'Repair needed',
            resolutionKind: 'critical_repair',
            certificateId: 'a'.repeat(64),
            repairPurpose: 'repair_confirmed_changes',
          },
          actions: ['resolve', 'cancel', 'resume'],
        })}
      />
    );
    expect(html).toContain('Continue reviewed tracking repair');
    expect(html).not.toContain('invalid-or-secret-value');
    expect(html).not.toContain('Request cancellation');
    expect(html).not.toContain('Resume task');
    expect(html).not.toContain('Existing destination item ID');
  });
  it('requires explicit source-certified legacy SoundCloud retention without remote ownership or deletion claims', () => {
    for (const repairPurpose of ['repair_confirmed_changes', 'complete_fixed_cleanup'] as const) {
      const html = renderToStaticMarkup(
        <JobStatusPanel
          job={job({
            state: 'needs_attention',
            actions: ['resolve', 'resume', 'retry', 'cancel'],
            attention: {
              kind: 'remote_drift',
              message: 'Legacy reference review',
              resolutionKind: 'critical_repair',
              certificateId: 'a'.repeat(64),
              repairPurpose,
              requiresRetentionAcknowledgement: true,
            },
          })}
        />
      );
      expect(html).toContain('original SoundCloud account cannot be verified');
      expect(html).toContain('its content may remain online');
      expect(html).toContain('Keep the existing SoundCloud track and finish saved cleanup');
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Keep track and finish saved cleanup/);
      expect(html).toContain('readOnly');
      if (repairPurpose === 'complete_fixed_cleanup') {
        expect(html).toContain('remove other original recorded resources pinned by this certificate');
        expect(html).toContain('original SoundCloud track will be kept');
      } else {
        expect(html).not.toContain('remove other original recorded resources pinned by this certificate');
      }
      expect(html).not.toContain('changes already confirmed');
      expect(html).not.toContain('Existing destination item ID');
      expect(html).not.toContain('Resume task');
      expect(html).not.toContain('Retry failed work');
      expect(html).not.toContain('Request cancellation');
    }
  });
  it('does not expose retention approval without its full certificate, admin and action capability', () => {
    const certified = {
      kind: 'remote_drift' as const,
      message: 'Legacy reference review',
      resolutionKind: 'critical_repair' as const,
      certificateId: 'a'.repeat(64),
      repairPurpose: 'complete_fixed_cleanup' as const,
      requiresRetentionAcknowledgement: true,
    };
    for (const patch of [
      { attention: { ...certified, certificateId: undefined }, actions: ['resolve'] as const },
      { attention: { ...certified, certificateId: 'arbitrary-track-id' }, actions: ['resolve'] as const },
      { attention: { ...certified, repairPurpose: undefined }, actions: ['resolve'] as const },
      { attention: certified, actions: [] },
    ]) {
      const html = renderToStaticMarkup(<JobStatusPanel job={job({ ...patch, actions: [...patch.actions] })} />);
      expect(html).not.toContain('Keep track and finish saved cleanup');
      expect(html).not.toContain('its content may remain online');
    }
    identity.user = { uid: 'uploader', isAdmin: () => false };
    const html = renderToStaticMarkup(<JobStatusPanel job={job({ attention: certified, actions: ['resolve'] })} />);
    expect(html).not.toContain('Keep track and finish saved cleanup');
  });
  it('keeps ordinary unknown-result recovery separate from the legacy source certificate flag', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          actions: ['resolve'],
          attention: {
            kind: 'external_result_unknown',
            message: 'Unknown creation',
            receiptId: 'receipt',
            requiresRetentionAcknowledgement: true,
          },
        })}
      />
    );
    expect(html).toContain('Verify and adopt existing item');
    expect(html).not.toContain('Keep track and finish saved cleanup');
  });
  it('shows the fixed critical cleanup purpose and readonly certificate with stale submission disabled', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        stale
        job={job({
          state: 'needs_attention',
          attention: {
            kind: 'remote_drift',
            message: 'Repair needed',
            resolutionKind: 'critical_repair',
            certificateId: 'a'.repeat(64),
            repairPurpose: 'complete_fixed_cleanup',
          },
          actions: ['resolve', 'cancel', 'resume'],
        })}
      />
    );
    expect(html).toContain('Finish removal of known records and repair tracking');
    expect(html).toContain('original recorded resources pinned by this certificate');
    expect(html).toContain('readOnly');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue reviewed cleanup/);
    expect(html).not.toContain('Existing destination item ID');
    expect(html).not.toContain('Request cancellation');
    expect(html).not.toContain('Resume task');
  });
  it('does not submit critical repair without a valid server certificate or purpose', () => {
    for (const attention of [
      { kind: 'remote_drift' as const, message: 'Repair needed', resolutionKind: 'critical_repair' as const },
      {
        kind: 'remote_drift' as const,
        message: 'Repair needed',
        resolutionKind: 'critical_repair' as const,
        certificateId: 'BAD-ID',
        repairPurpose: 'repair_confirmed_changes' as const,
      },
    ]) {
      const html = renderToStaticMarkup(
        <JobStatusPanel job={job({ state: 'needs_attention', attention, actions: ['resolve'] })} />
      );
      expect(html).toContain('verified repair certificate is not available');
      expect(html).not.toContain('Continue reviewed');
      expect(html).not.toContain('Existing destination item ID');
    }
  });
  it('keeps critical repair approval restricted to administrators even for the requester', () => {
    identity.user = { uid: 'uploader', isAdmin: () => false };
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'needs_attention',
          attention: {
            kind: 'remote_drift',
            message: 'Repair needed',
            resolutionKind: 'critical_repair',
            certificateId: 'a'.repeat(64),
            repairPurpose: 'repair_confirmed_changes',
          },
          actions: ['resolve', 'resume'],
        })}
      />
    );
    expect(html).not.toContain('Repair certificate');
    expect(html).not.toContain('Continue reviewed');
    expect(html).not.toContain('Resume task');
  });
  it('reviews standalone late allocations without cancellation or resuming the original task', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          kind: 'provider.orphan_review',
          state: 'needs_attention',
          entity: { type: 'maintenance', id: 'orphan-case' },
          result: { sourceJobId: 'original-job' },
          attention: { kind: 'external_result_unknown', message: 'Additional allocation', acknowledgementId: 'ack' },
          actions: ['resolve', 'cancel', 'resume'],
        })}
      />
    );
    expect(html).toContain('Review additional provider item');
    expect(html).toContain('/admin/activity/original-job');
    expect(html).not.toContain('Request cancellation');
    expect(html).not.toContain('Resume task');
  });
  it('uses deliberate retention for an unknown cleanup allocation without promising deletion', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          kind: 'image.delete',
          state: 'needs_attention',
          result: { resolutionPurpose: 'cleanup' },
          attention: { kind: 'external_result_unknown', message: 'Allocation unknown', receiptId: 'receipt' },
          actions: ['resolve'],
        })}
      />
    );
    expect(html).toContain('Verify and keep selected image');
    expect(html).toContain('original allocation may still be unknown');
    expect(html).not.toContain('will be deleted');
    expect(html).not.toContain('Verify and adopt existing item');
  });
  it('offers known-resource retention only for the explicit server capability and fixed ID', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'needs_attention',
          attention: {
            kind: 'external_result_unknown',
            message: 'Cleanup needs review',
            receiptId: 'confirmed-receipt',
            remoteId: 'fixed-resource',
            resolutionKind: 'retain_existing_resource',
          },
          actions: ['resolve', 'retry', 'resume'],
        })}
      />
    );
    expect(html).toContain('Verify and keep this resource');
    expect(html).toContain('Confirmed item:');
    expect(html).toContain('fixed-resource');
    expect(html).not.toContain('Existing destination item ID');
    expect(html).not.toContain('Retry failed work');
  });
  it('offers verified prior removal only when the server advertises that decision', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          kind: 'image.delete',
          state: 'needs_attention',
          attention: {
            kind: 'external_result_unknown',
            message: 'Shared image review',
            receiptId: 'receipt',
            remoteId: 'shared-image',
            resolutionKind: 'retain_existing_resource',
            resolutionDecisions: ['retain_existing_resource', 'confirm_existing_resource_absent'],
          },
          actions: ['resolve'],
        })}
      />
    );
    expect(html).toContain('Shared resource decision');
    expect(html).not.toContain('will be deleted');
    expect(html).not.toContain('Existing destination item ID');
  });
  it('reports retained remote images truthfully after local cleanup', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          kind: 'image.delete',
          state: 'succeeded',
          result: { status: 'remote_retained', deleted: false },
          actions: [],
        })}
      />
    );
    expect(html).toContain('Local cleanup finished. The remote image was retained.');
  });
  it('requires explicit retention of a confirmed additional allocation and offers no generic retry', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          state: 'needs_attention',
          attention: { kind: 'external_result_unknown', message: 'Additional allocation', acknowledgementId: 'ack' },
          actions: ['resolve', 'retry', 'resume'],
        })}
      />
    );
    expect(html).toContain('Verify and retain additional item');
    expect(html).toContain('A duplicate provider item will remain');
    expect(html).toContain('Additional item decision');
    expect(html).toContain('Neither decision deletes the adopted item');
    expect(html).not.toContain('Existing destination item ID');
    expect(html).not.toContain('Retry failed work');
  });
  it('reviews uncertain session revocation separately from access claims', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({
          kind: 'role.assign',
          state: 'needs_attention',
          error: { code: 'ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED', message: 'Sessions uncertain', retryable: false },
          actions: ['resolve', 'retry', 'resume'],
        })}
      />
    );
    expect(html).toContain('Verify sessions already revoked');
    expect(html).toContain('account session cutoff');
    expect(html).not.toContain('Verify access already applied');
    expect(html).not.toContain('Retry failed work');
  });
  it('uses email-specific review choices rather than generic remote-ID adoption', () => {
    const html = renderToStaticMarkup(
      <JobStatusPanel
        job={job({ kind: 'email.deliver', state: 'needs_attention', actions: ['resolve', 'retry', 'resume'] })}
      />
    );
    expect(html).toContain('Reviewed outcome');
    expect(html).toContain('Apply reviewed outcome');
    expect(html).not.toContain('Retry failed work');
    expect(html).not.toContain('Existing destination item ID');
  });
});
