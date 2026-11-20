import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DurableJob, DurableJobRef, DurableEntityRef } from '@upperroom/contracts/temporal';
import type { ProviderSandboxStatus } from '@upperroom/contracts/providerSandbox';
import type { Sermon } from '../types/SermonTypes';
import { sermonStatusType, uploadStatus } from '../types/SermonTypes';

const useDurableJobMock = jest.fn();
const useEntityJobsMock = jest.fn();
const collectionDataMock = jest.fn();
const documentDataMock = jest.fn();
const providerEnvironmentMock = jest.fn();
let admin = true;
// This render suite consumes verified provider status; callable initialization and status loading
// belong to the provider context's integration boundary, not the panel's Firebase fixtures.
jest.mock('../context/provider/ProviderEnvironmentContext', () => ({
  useProviderEnvironment: () => providerEnvironmentMock(),
}));
jest.mock('../hooks/useDurableJobs', () => ({
  useDurableJob: (id?: string) => useDurableJobMock(id),
  useEntityJobs: (entity: DurableEntityRef, refs?: Record<string, DurableJobRef | undefined>) =>
    useEntityJobsMock(entity, refs),
}));
jest.mock('../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({ user: { uid: 'owner', canPublish: () => true, isAdmin: () => admin } }),
}));
jest.mock('../utils/durableJobs', () => ({
  submitDurableCommand: jest.fn(),
  submitDurableIntent: jest.fn(),
  DurableAdmissionUnknownError: class extends Error {},
}));
jest.mock('../components/AvatarWithDefaultImage', () => ({ __esModule: true, default: () => null }));
jest.mock('../firebase/firebase', () => ({ isDevelopment: false }));
jest.mock('../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  collection: () => ({ withConverter: () => ({}) }),
  doc: () => ({ withConverter: () => ({}) }),
}));
jest.mock('react-firebase-hooks/firestore', () => ({
  useCollectionData: () => collectionDataMock(),
  useDocumentData: () => documentDataMock(),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// Render the actual dialog contents, since MUI's portal deliberately renders nothing in SSR.
jest.mock('@mui/material/Dialog', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));

import UploadProgressComponent from '../components/uploaderComponents/UploadProgressComponent';
import JobStatusPanel from '../components/jobs/JobStatusPanel';
import SermonPublishPanel from '../components/SermonPublishPanel';
import ProviderSimulationBanner from '../components/ProviderSimulationBanner';
import { emptySermonList } from '../types/SermonList';

const job = (overrides: Partial<DurableJob> = {}): DurableJob => ({
  schemaVersion: 1,
  jobId: 'upload',
  projectId: 'test',
  kind: 'upload.create',
  entity: { type: 'sermon', id: 'sermon' },
  workflowId: 'workflow',
  generation: 1,
  revision: 1,
  requestedBy: 'owner',
  requestId: 'request',
  state: 'succeeded',
  createdAt: 1,
  updatedAt: 2,
  steps: [],
  actions: [],
  ...overrides,
});
const sermon: Sermon = {
  id: 'sermon',
  title: 'A sermon',
  subtitle: '',
  description: '',
  speakers: [],
  topics: [],
  images: [],
  dateMillis: 1,
  sourceStartTime: 0,
  durationSeconds: 60,
  createdAtMillis: 1,
  editedAtMillis: 2,
  status: {
    audioStatus: sermonStatusType.PROCESSED,
    soundCloud: uploadStatus.UPLOADED,
    subsplash: uploadStatus.UPLOADED,
  },
};
const receipt = {
  jobId: 'upload',
  projectId: 'test',
  requestId: 'request',
  admissionState: 'accepted' as const,
  revision: 1,
  generation: 1,
};
const status = (current?: DurableJob) => ({ job: current, loading: false, stale: false, error: null });
const buttonMarkup = (html: string, label: string) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .filter((markup) => markup.includes(`>${label}<`));

beforeEach(() => {
  admin = true;
  jest.clearAllMocks();
  providerEnvironmentMock.mockReturnValue({
    status: {
      mode: 'live',
      ready: true,
      catalogReady: false,
      scenarioSelectionAllowed: false,
    } satisfies ProviderSandboxStatus,
    loading: false,
    error: false,
    refresh: jest.fn(),
  });
  useDurableJobMock.mockImplementation((id?: string) => ({ ...status(), stale: !id }));
  useEntityJobsMock.mockReturnValue({ jobs: [], loading: false, stale: false, error: null });
  collectionDataMock.mockReturnValue([
    [
      {
        ...emptySermonList,
        id: 'list',
        name: 'List',
        uploadStatus: { status: uploadStatus.UPLOADED, listItemId: 'remote' },
      },
    ],
    false,
    null,
  ]);
  documentDataMock.mockReturnValue([undefined, false, null]);
});

describe('rendered durable job tracking', () => {
  it('exposes the advanced configuration disclosure state and its controlled content', () => {
    const closed = renderToStaticMarkup(<SermonPublishPanel sermon={sermon} />);
    expect(buttonMarkup(closed, 'Advanced publish config')[0]).toContain('aria-expanded="false"');
    const open = renderToStaticMarkup(<SermonPublishPanel sermon={sermon} initialAdvancedOpen />);
    const button = buttonMarkup(open, 'Hide advanced config')[0];
    expect(button).toContain('aria-expanded="true"');
    const controlledId = button.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeTruthy();
    expect(open).toContain(`id="${controlledId}"`);
  });

  it('shows an ordinary publisher the actual attention state without technical history', () => {
    admin = false;
    useEntityJobsMock.mockReturnValue({
      jobs: [
        job({
          kind: 'sermon.publish',
          state: 'needs_attention',
          actions: ['cancel'],
          attention: { kind: 'external_result_unknown', message: 'The destination needs review.' },
        }),
      ],
      loading: false,
      stale: false,
      error: null,
    });
    const html = renderToStaticMarkup(<SermonPublishPanel sermon={sermon} showActivityHistory={false} />);
    expect(html).toContain('Needs attention');
    expect(html).toContain('The destination needs review.');
    expect(html).toContain('Request cancellation');
    expect(html).not.toContain('aria-label="Recent activity"');
    expect(html).not.toContain('Follow its steps below');
    expect(html).not.toContain('/admin/activity');
  });

  it('omits embedded history when the details page provides advanced activity separately', () => {
    const html = renderToStaticMarkup(<SermonPublishPanel sermon={sermon} showActivityHistory={false} />);
    expect(html).not.toContain('aria-label="Recent activity"');
    expect(buttonMarkup(html, 'Unpublish From Everywhere')).toHaveLength(1);
    const standalone = renderToStaticMarkup(<SermonPublishPanel sermon={sermon} />);
    expect(standalone).toContain('aria-label="Recent activity"');
  });

  it.each([
    { name: 'loading', status: undefined, loading: true, error: false },
    { name: 'unavailable', status: undefined, loading: false, error: true },
    { name: 'unverified', status: undefined, loading: false, error: false },
    {
      name: 'catalog not ready',
      status: {
        mode: 'blocked',
        ready: false,
        catalogReady: false,
        scenarioSelectionAllowed: false,
        reason: 'catalog-not-ready',
      } satisfies ProviderSandboxStatus,
      loading: false,
      error: false,
    },
  ])('keeps publishing paused when provider authority is $name', ({ name: _name, ...environment }) => {
    providerEnvironmentMock.mockReturnValue({ ...environment, refresh: jest.fn() });
    const html = renderToStaticMarkup(<SermonPublishPanel sermon={sermon} />);
    expect(html).toContain('Publishing is paused until the server confirms the publishing mode.');
    expect(buttonMarkup(html, 'Unpublish From Everywhere')).toHaveLength(1);
    expect(buttonMarkup(html, 'Unpublish From Everywhere')[0]).toContain('disabled=""');
    expect(html).not.toContain('Scenario for the next simulated request');
    const notice = renderToStaticMarkup(<ProviderSimulationBanner />);
    expect(notice).toContain(
      environment.loading ? 'Checking publishing mode' : 'Publishing mode could not be verified. Publishing is paused.'
    );
    expect(notice).not.toContain('changes are simulated');
  });

  it('keeps verified live publishing available without a simulation notice or scenario selector', () => {
    expect(renderToStaticMarkup(<ProviderSimulationBanner />)).toBe('');
    const html = renderToStaticMarkup(<SermonPublishPanel sermon={sermon} />);
    expect(html).not.toContain('Scenario for the next simulated request');
    expect(buttonMarkup(html, 'Unpublish From Everywhere')[0]).not.toContain('disabled=""');
  });

  it('renders the verified simulation notice and per-request scenario control only when authorized', () => {
    const status: ProviderSandboxStatus = {
      mode: 'sandbox',
      ready: true,
      catalogReady: true,
      profileId: 'urm-app-staging-publishing-v1',
      version: 1,
      scenarioSelectionAllowed: true,
    };
    providerEnvironmentMock.mockReturnValue({ status, loading: false, error: false, refresh: jest.fn() });
    const notice = renderToStaticMarkup(<ProviderSimulationBanner />);
    expect(notice).toContain('Subsplash and SoundCloud changes are simulated');
    expect(notice).toContain('audio processing still use staging');
    const panel = renderToStaticMarkup(<SermonPublishPanel sermon={sermon} />);
    expect(panel).toContain('Scenario for the next simulated request');
    expect(panel).toContain('Retries keep the task’s original scenario.');
    expect(buttonMarkup(panel, 'Unpublish From Everywhere')[0]).not.toContain('disabled=""');
    providerEnvironmentMock.mockReturnValue({
      status: { ...status, scenarioSelectionAllowed: false },
      loading: false,
      error: false,
      refresh: jest.fn(),
    });
    expect(renderToStaticMarkup(<SermonPublishPanel sermon={sermon} />)).not.toContain(
      'Scenario for the next simulated request'
    );
  });

  it.each(['not_started', 'partial'] as const)(
    'shows certified %s stops without success or replay controls',
    (providerEffects) => {
      const stopped = job({
        kind: 'sermon.delete',
        state: 'cancelled',
        result: { mode: 'partial_stop', providerEffects, contentPreserved: true },
        actions: ['retry', 'resume', 'resolve'],
      });
      const html = renderToStaticMarkup(<JobStatusPanel job={stopped} />);
      expect(html).toContain('Stopped');
      expect(html).toContain(
        providerEffects === 'not_started'
          ? 'Stopped before destination changes. Content was kept.'
          : 'Stopped after some destination changes. Remaining content was kept.'
      );
      expect(html).toContain('Review the destination before starting a new task.');
      expect(html).not.toContain('>Complete<');
      expect(buttonMarkup(html, 'Retry failed work')).toHaveLength(0);
      expect(buttonMarkup(html, 'Resume task')).toHaveLength(0);
      expect(html).not.toContain('Confirm reviewed resource');
    }
  );

  it('keeps the familiar upload dialog with one cancellation action and sermon link, without activity cards', () => {
    const upload = job({ result: { mediaJobId: 'audio' } });
    const audio = job({ jobId: 'audio', kind: 'audio.process', state: 'queued', actions: ['cancel'] });
    useDurableJobMock.mockImplementation((id?: string) =>
      status(id === 'upload' ? upload : id === 'audio' ? audio : undefined)
    );
    const html = renderToStaticMarkup(
      <UploadProgressComponent
        isUploading={false}
        audioSource={undefined}
        uploadProgress={{ phase: 'admitting', percent: 100, message: '', error: false }}
        receipt={receipt}
        sermon={sermon}
        onNavigateToSermon={() => undefined}
      />
    );
    expect(html).not.toContain('aria-label="Process audio status"');
    expect(html).toContain('aria-label="Audio processing"');
    expect(buttonMarkup(html, 'Request cancellation')).toHaveLength(1);
    expect(buttonMarkup(html, 'View Sermon')).toHaveLength(1);
    expect(html).not.toContain('>Open sermon<');
    expect(html).toContain('Source received');
    expect(html).toContain('Queued');
    expect(html).not.toMatch(/role="status"[^>]*>Complete</);
  });

  it.each([
    { state: 'queued' as const, stale: false, complete: false },
    { state: 'succeeded' as const, stale: true, complete: false },
    { state: 'succeeded' as const, stale: false, complete: true },
  ])(
    'shows completion only for fresh, confirmed audio processing: $state / stale=$stale',
    ({ state, stale, complete }) => {
      const upload = job({ result: { mediaJobId: 'audio' } });
      const audio = job({ jobId: 'audio', kind: 'audio.process', state });
      useDurableJobMock.mockImplementation((id?: string) => ({
        ...status(id === 'upload' ? upload : id === 'audio' ? audio : undefined),
        stale: id === 'audio' && stale,
      }));
      const html = renderToStaticMarkup(
        <UploadProgressComponent
          isUploading={false}
          audioSource={undefined}
          uploadProgress={{ phase: 'admitted', percent: 100, message: '', error: false }}
          receipt={receipt}
          sermon={sermon}
          onNavigateToSermon={() => undefined}
        />
      );
      expect(html.includes('Upload Complete!')).toBe(complete);
      expect(html).not.toContain('/admin/activity');
      expect(html).not.toContain('Workflow');
      if (!complete) expect(html).not.toContain('aria-valuenow="100"');
    }
  );

  it('shows measured file transfer without treating 100 percent sent as processing completion', () => {
    useDurableJobMock.mockReturnValue({ ...status(), stale: true });
    const html = renderToStaticMarkup(
      <UploadProgressComponent
        isUploading
        audioSource={{ type: 'File', source: new File(['audio'], 'sermon.wav') }}
        uploadProgress={{ phase: 'transferring', percent: 100, message: '', error: false }}
        sermon={sermon}
      />
    );
    expect(html).toContain('aria-label="Audio file transfer"');
    expect(html).not.toContain('Reconnecting');
    expect(html).toContain('aria-valuenow="100"');
    expect(html).not.toContain('Upload Complete!');
    expect(buttonMarkup(html, 'View Sermon')).toHaveLength(0);
  });

  it('propagates suppressed entity navigation into the single child panel', () => {
    const audio = job({ jobId: 'audio', kind: 'audio.process', state: 'running', actions: ['cancel'] });
    useDurableJobMock.mockImplementation((id?: string) => status(id === 'audio' ? audio : undefined));
    const html = renderToStaticMarkup(
      <JobStatusPanel job={job({ result: { mediaJobId: 'audio' } })} showEntityLink={false} />
    );
    expect((html.match(/aria-label="Process audio status"/g) ?? []).length).toBe(1);
    expect(buttonMarkup(html, 'Request cancellation')).toHaveLength(1);
    expect(html).not.toContain('>Open sermon<');
  });

  it('disables publishing when an older active referenced job is outside the recent 25 jobs', () => {
    const active = job({ jobId: 'older-active', kind: 'sermon.publish', state: 'retrying', createdAt: 0 });
    const refs = { publishing: { jobId: active.jobId, projectId: 'test' } };
    const recent = Array.from({ length: 25 }, (_, index) =>
      job({ jobId: `recent-${index}`, kind: 'sermon.publish', createdAt: index + 10 })
    );
    useEntityJobsMock.mockImplementation(
      (_entity: DurableEntityRef, activeRefs?: Record<string, DurableJobRef | undefined>) => ({
        jobs: activeRefs?.publishing?.jobId === active.jobId ? [...recent, active] : recent,
        loading: false,
        stale: false,
        error: null,
      })
    );
    const withoutActiveReference = renderToStaticMarkup(<SermonPublishPanel sermon={sermon} />);
    expect(buttonMarkup(withoutActiveReference, 'Unpublish From Everywhere')[0]).not.toContain('disabled=""');
    const html = renderToStaticMarkup(<SermonPublishPanel sermon={{ ...sermon, activeDurableJobs: refs }} />);
    expect(useEntityJobsMock).toHaveBeenCalledWith({ type: 'sermon', id: 'sermon' }, refs);
    expect(html).toContain('aria-label="Current request status"');
    expect(buttonMarkup(html, 'Unpublish From Everywhere')).toHaveLength(1);
    expect(buttonMarkup(html, 'Unpublish From Everywhere')[0]).toContain('disabled=""');
    expect(html).toContain('Retrying automatically');
  });
});
