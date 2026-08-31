import assert from 'node:assert/strict';
import { createChildContext, createContext } from '../src/context';
import {
  completeProcessAudioSuccess,
  setProcessAudioTaskQueueFactoryForTesting,
} from '../src/processAudioQueueStore';

class MockSnapshot {
  constructor(private readonly value: unknown) {}

  exists(): boolean {
    return this.value !== undefined && this.value !== null;
  }

  val(): unknown {
    return this.value;
  }
}

class MockRef {
  constructor(private readonly store: Record<string, unknown>, private readonly key: string) {}

  async get(): Promise<MockSnapshot> {
    if (Object.prototype.hasOwnProperty.call(this.store, this.key)) {
      return new MockSnapshot(this.store[this.key]);
    }

    const prefix = `${this.key}/`;
    const children = Object.entries(this.store).reduce<Record<string, unknown>>((result, [key, value]) => {
      if (key.startsWith(prefix)) result[key.slice(prefix.length).split('/')[0]] = value;
      return result;
    }, {});
    return new MockSnapshot(Object.keys(children).length > 0 ? children : undefined);
  }

  async set(value: unknown): Promise<void> {
    this.store[this.key] = value;
  }

  async update(patch: Record<string, unknown>): Promise<void> {
    this.store[this.key] = {
      ...((this.store[this.key] as Record<string, unknown> | undefined) ?? {}),
      ...patch,
    };
  }

  async remove(): Promise<void> {
    delete this.store[this.key];
  }

  async transaction(updateFn: (current: unknown) => unknown): Promise<{ committed: boolean; snapshot: MockSnapshot }> {
    const next = updateFn(this.store[this.key]);
    if (typeof next === 'undefined') {
      return { committed: false, snapshot: new MockSnapshot(this.store[this.key]) };
    }
    this.store[this.key] = next;
    return { committed: true, snapshot: new MockSnapshot(next) };
  }
}

async function main(): Promise<void> {
  const payload = {
    id: 'probe-sermon',
    youtubeUrl: 'https://www.youtube.com/watch?v=dKaZ89SkVYY',
    startTime: 0,
    duration: 180,
  } as const;
  const store: Record<string, unknown> = {
    'processAudioQueues/youtube/state': {
      blocked: true,
      blockerReason: 'cookie_session_stale_or_challenged',
      blockedAt: '2026-08-24T00:00:00.000Z',
      blockerEpisodeId: 'probe-episode',
      probeMode: 'cookie_provider',
      probeStatus: 'probing',
      probeTaskSermonId: payload.id,
      probeRequestVersion: 'probe-version',
      probeStartedAt: '2026-08-24T00:05:00.000Z',
      probeLastSucceededAt: null,
      probeLastFailedAt: null,
      probeLastFailureClass: null,
      probeLastFailureMessage: null,
      alertSentAt: null,
      deferredYouTubeTaskCount: 0,
    },
    [`processAudioRequests/${payload.id}`]: {
      sermonId: payload.id,
      sourceType: 'youtube',
      currentPayload: payload,
      currentRequestVersion: 'probe-version',
      queuedTaskId: 'probe-task',
      queuedAt: '2026-08-24T00:04:00.000Z',
      runningRequestId: 'probe-request',
      runningTaskId: 'probe-task',
      runningRequestVersion: 'probe-version',
      runningAt: '2026-08-24T00:05:00.000Z',
      nextPayload: null,
      nextRequestVersion: null,
      nextUpdatedAt: null,
      deferredAt: null,
      updatedAt: '2026-08-24T00:05:00.000Z',
    },
  };
  const database = { ref: (key: string) => new MockRef(store, key) };
  setProcessAudioTaskQueueFactoryForTesting(() => ({ async delete(): Promise<void> {} }));

  const requestContext = createContext(payload.id, 'process-audio');
  const trimContext = createChildContext(requestContext, 'trim');
  trimContext.youtubeSuccessfulAcquisitionAuthority = 'cookie_provider';

  await completeProcessAudioSuccess({
    database: database as any,
    payload,
    requestId: requestContext.requestId,
    taskId: 'probe-task',
    ctx: requestContext,
    alreadyProcessed: false,
  });

  const queueState = store['processAudioQueues/youtube/state'] as Record<string, unknown>;
  assert.equal(
    queueState.probeStatus,
    'idle',
    'the request handler must preserve authenticated acquisition authority recorded by its trim child context'
  );
  assert.equal(typeof queueState.probeLastSucceededAt, 'string');
  assert.equal(requestContext.youtubeSuccessfulAcquisitionAuthority, 'cookie_provider');

  setProcessAudioTaskQueueFactoryForTesting(null);
  console.log('process-audio request context propagation tests passed');
}

main().catch((error) => {
  setProcessAudioTaskQueueFactoryForTesting(null);
  console.error(error);
  process.exitCode = 1;
});
