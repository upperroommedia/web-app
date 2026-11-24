import { JobRegistry, type JobObserver } from '../../context/jobs/jobRegistry';
import type { DurableJob } from '@upperroom/contracts/temporal';
import { sermonStatusType } from '../../types/SermonTypes';
import { getSermonProcessing } from '../../utils/sermonProcessing';

const job = (revision: number, state: DurableJob['state'] = 'running'): DurableJob => ({
  schemaVersion: 1,
  jobId: 'j1',
  projectId: 'urm-test',
  kind: 'audio.process',
  entity: { type: 'sermon', id: 's1' },
  workflowId: 'wf1',
  generation: 1,
  revision,
  requestedBy: 'u1',
  requestId: 'r1',
  state,
  createdAt: 1,
  updatedAt: revision,
  steps: [],
  actions: [],
});

describe('shared durable job observations', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it('shares one source across many consumers and closes when the last releases', () => {
    const registry = new JobRegistry();
    const stop = jest.fn();
    const source = jest.fn(() => stop);
    const releases = Array.from({ length: 50 }, () => registry.subscribe('uid:scope', source, jest.fn()));
    expect(source).toHaveBeenCalledTimes(1);
    releases.slice(0, 49).forEach((release) => release());
    jest.runOnlyPendingTimers();
    expect(stop).not.toHaveBeenCalled();
    releases[49]();
    jest.runOnlyPendingTimers();
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('does not regress confirmed completion when a delayed cache snapshot arrives', () => {
    const registry = new JobRegistry();
    let next!: JobObserver;
    registry.subscribe(
      'uid:scope',
      (observer) => {
        next = observer;
        return () => undefined;
      },
      jest.fn()
    );
    next([job(9, 'succeeded')], false);
    next([job(3)], true);
    expect(registry.snapshot('uid:scope').jobs[0]).toMatchObject({ revision: 9, state: 'succeeded' });
    expect(registry.snapshot('uid:scope').stale).toBe(true);
    next([], true);
    expect(registry.snapshot('uid:scope').jobs).toHaveLength(1);
    next([], false);
    expect(registry.snapshot('uid:scope').jobs).toHaveLength(0);
  });
  it('preserves outcome on read failure and clears identity data on logout', () => {
    const registry = new JobRegistry();
    let next!: JobObserver;
    let fail!: (message: string) => void;
    const stop = jest.fn();
    registry.subscribe(
      'uid:scope',
      (observer, error) => {
        next = observer;
        fail = error;
        return stop;
      },
      jest.fn()
    );
    next([job(9, 'succeeded')], false);
    fail('Offline');
    expect(registry.snapshot('uid:scope')).toMatchObject({ stale: true, error: 'Offline' });
    expect(registry.snapshot('uid:scope').jobs[0].state).toBe('succeeded');
    registry.clear();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.snapshot('uid:scope').jobs).toHaveLength(0);
  });
  it('preserves a stopped upload alongside an active publishing job until the source is replaced', () => {
    const registry = new JobRegistry();
    let next!: JobObserver;
    registry.subscribe(
      'uid:scope',
      (observer) => {
        next = observer;
        return () => undefined;
      },
      jest.fn()
    );
    const publishing: DurableJob = { ...job(1), jobId: 'publishing', kind: 'sermon.publish', createdAt: 2 };
    const stopped: DurableJob = { ...job(2, 'cancelled'), jobId: 'stopped', kind: 'upload.create' };
    const processing = () =>
      getSermonProcessing(registry.entitySnapshot('uid:scope', stopped.entity).jobs, sermonStatusType.PENDING, false);
    next([publishing, stopped], false);
    expect(processing()).toMatchObject({ stopped: true, pending: false, label: 'Upload stopped' });
    next(
      [
        { ...job(3), jobId: 'replacement', kind: 'upload.create', state: 'awaiting_source', createdAt: 3 },
        publishing,
        stopped,
      ],
      false
    );
    expect(processing()).toMatchObject({ stopped: false, pending: true, label: 'Waiting for file' });
  });
});
