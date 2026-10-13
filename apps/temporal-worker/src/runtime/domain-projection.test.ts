import {
  createDomainAttentionProjection,
  createDomainSuccessProjection,
  createStoppedRepairProjection,
} from './domain-projection';
test('ambiguous cancellation keeps a live resolve-only cleanup surface', () => {
  const projection = createDomainAttentionProjection({ kind: 'sermon.publish' }, 'cleanup', {
    state: 'needs_review',
    code: 'PROVIDER_CREATE_AMBIGUOUS',
    receiptId: 'safe-receipt',
    cancelOnly: true,
  });
  expect(projection).toMatchObject({
    state: 'cancel_requested',
    actions: ['resolve'],
    attention: { kind: 'external_result_unknown', receiptId: 'safe-receipt' },
    result: { resolutionPurpose: 'cleanup' },
  });
  expect(projection.finishedAt).toBeUndefined();
});
test('mutable provider review preserves only its opaque private session reference', () => {
  const projection = createDomainAttentionProjection({ kind: 'sermon.publish' }, 'cleanup', {
    state: 'blocked',
    code: 'PUBLISHING_CANCEL_MUTATION_REVIEW_REQUIRED',
    cancelOnly: true,
    mutationSessionId: 'a'.repeat(64),
  });
  expect(projection.result).toMatchObject({ resolutionPurpose: 'cleanup', mutationSessionId: 'a'.repeat(64) });
  expect(projection.actions).toEqual([]);
  expect(projection.attention?.message).toContain('original provider request may still arrive');
  expect(projection.attention?.message).toContain('Cancellation remains pending');
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'cleanup', {
      state: 'blocked',
      cancelOnly: true,
      mutationSessionId: 'private/session/headers',
    }).result
  ).not.toHaveProperty('mutationSessionId');
});
test('unknown desired mutable requests have no generic replay or provider-ID resolution action', () => {
  const projection = createDomainAttentionProjection({ kind: 'sermon.publish' }, 'projection', {
    state: 'blocked',
    code: 'PROVIDER_MUTATION_UNRESOLVED',
  });
  expect(projection.actions).toEqual([]);
  expect(projection.attention).toMatchObject({ kind: 'external_result_unknown' });
  expect(projection.attention?.message).toContain('original provider request may still arrive');
});
test('unknown account access cannot be resumed or cancelled before audited resolution', () => {
  expect(
    createDomainAttentionProjection({ kind: 'role.assign' }, 'claims', {
      state: 'blocked',
      code: 'ACCOUNT_CLAIMS_RECONCILIATION_REQUIRED',
    })
  ).toMatchObject({ state: 'needs_attention', actions: ['resolve'], attention: { kind: 'external_result_unknown' } });
});
test('automatic provider retries retain cancel without inventing a retry deadline', () => {
  const projection = createDomainAttentionProjection({ kind: 'sermon.publish' }, 'provider-audio', {
    state: 'failed',
    code: 'PUBLISHING_AUDIO_PROCESSING',
  });
  expect(projection).toMatchObject({ state: 'retrying', actions: ['cancel'], error: { retryable: true } });
  expect(projection.attention).toBeUndefined();
  expect(projection).not.toHaveProperty('nextRetryAt');
});

test('cross-job provider allocation wait exposes only a safe task ID and remains cancellable', () => {
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'subsplash-media', {
      state: 'blocked',
      code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
      blockingJobId: 'job_123',
    })
  ).toMatchObject({
    state: 'retrying',
    actions: ['cancel'],
    result: { blockingJobId: 'job_123' },
    error: {
      retryable: true,
      message: 'Waiting for another publishing task to finish or be reviewed.',
    },
  });
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'subsplash-media', {
      state: 'blocked',
      code: 'PUBLISHING_PROVIDER_ALLOCATION_REVIEW_REQUIRED',
      blockingJobId: 'job_123',
    })
  ).toMatchObject({ state: 'needs_attention', result: { blockingJobId: 'job_123' } });
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'subsplash-media', {
      state: 'blocked',
      code: 'PUBLISHING_PROVIDER_ALLOCATION_PENDING',
      blockingJobId: 'private/path',
    })
  ).not.toHaveProperty('result');
});

test('known provider fetch waits automatically without offering an ambiguity decision', () => {
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'cleanup', {
      state: 'blocked',
      code: 'PUBLISHING_CANCEL_PROVIDER_FETCH_PENDING',
      cancelOnly: true,
    })
  ).toMatchObject({ state: 'cancel_requested', actions: [], attention: undefined, error: { retryable: true } });
});

test('confirmed steps clear their own attention without clearing another destination or cancellation', () => {
  const job: any = {
    kind: 'sermon.publish',
    state: 'needs_attention',
    revision: 5,
    attention: { kind: 'external_result_unknown', stepId: 'soundcloud-track' },
  };
  expect(createDomainSuccessProjection(job, 'soundcloud-track', { state: 'completed' })).toEqual({
    state: 'running',
    expectedRevision: 5,
    actions: ['cancel'],
  });
  expect(createDomainSuccessProjection(job, 'lists', { state: 'completed' })).toBeUndefined();
  expect(
    createDomainSuccessProjection({ ...job, result: { resolutionPurpose: 'cleanup' } }, 'soundcloud-track', {
      state: 'completed',
    })
  ).toBeUndefined();
  expect(
    createDomainSuccessProjection({ ...job, kind: 'role.assign' }, 'soundcloud-track', { state: 'completed' })
  ).toMatchObject({ actions: [] });
});

test('one destination retry cannot hide another destination receipt review', () => {
  const job: any = {
    kind: 'sermon.publish',
    state: 'needs_attention',
    actions: ['resolve', 'cancel'],
    attention: { kind: 'external_result_unknown', stepId: 'soundcloud-track', receiptId: 'existing-receipt' },
    error: { code: 'PROVIDER_CREATE_AMBIGUOUS', message: 'Review', retryable: false },
  };
  expect(
    createDomainAttentionProjection(job, 'subsplash-media', { state: 'failed', code: 'PUBLISHING_TRANSIENT' })
  ).toMatchObject({
    state: 'needs_attention',
    actions: ['resolve', 'cancel'],
    attention: { receiptId: 'existing-receipt' },
    error: { code: 'PROVIDER_CREATE_AMBIGUOUS' },
  });
});

test('uncertain session revocation exposes audited resolution rather than repeating the Auth RPC', () => {
  expect(
    createDomainAttentionProjection({ kind: 'role.assign' }, 'sessions', {
      state: 'blocked',
      code: 'ACCOUNT_SESSIONS_RECONCILIATION_REQUIRED',
    })
  ).toMatchObject({ state: 'needs_attention', actions: ['resolve'], attention: { kind: 'external_result_unknown' } });
});

test('orphan review forwards only its opaque acknowledgement ID', () => {
  const ack = 'a'.repeat(64);
  const project = createDomainAttentionProjection({ kind: 'sermon.publish' }, 'cleanup', {
    state: 'blocked',
    cancelOnly: true,
    acknowledgementId: ack,
  });
  expect(project.attention).toMatchObject({ acknowledgementId: ack });
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'cleanup', {
      state: 'blocked',
      cancelOnly: true,
      acknowledgementId: 'private-provider-body',
    }).attention
  ).not.toHaveProperty('acknowledgementId');
});

test('a paged confirmed repair stays live without advertising another review or replay', () => {
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'cleanup', {
      state: 'running',
      code: 'PUBLISHING_CRITICAL_REPAIR_PROJECTION_PENDING',
      cancelOnly: true,
    })
  ).toMatchObject({
    state: 'cancel_requested',
    actions: [],
    attention: undefined,
    error: { retryable: true, message: 'Confirmed destination changes are being applied to tracking.' },
  });
});

test('a proved unsent graph change requests a fresh intent without resuming an aborted session', () => {
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'lists', {
      state: 'blocked',
      code: 'PROVIDER_MUTATION_GRAPH_CHANGED_UNSENT',
    })
  ).toMatchObject({
    state: 'needs_attention',
    actions: ['cancel'],
    attention: { message: 'The destination changed before any request was sent. Refresh it and submit a new task.' },
    error: { retryable: false },
  });
});

test('deletion settlement pending remains an automatic proof wait until its explicit review budget expires', () => {
  expect(
    createDomainAttentionProjection({ kind: 'sermon.delete' }, 'projection', {
      state: 'failed',
      code: 'PUBLISHING_DELETION_SETTLEMENT_PENDING',
    })
  ).toMatchObject({
    state: 'retrying',
    error: { retryable: true, message: 'Confirming deletion tracking before completing this task.' },
  });
  expect(
    createDomainAttentionProjection({ kind: 'sermon.delete' }, 'projection', {
      state: 'failed',
      code: 'PUBLISHING_DELETION_SETTLEMENT_REVIEW_REQUIRED',
    })
  ).toMatchObject({ state: 'needs_attention', error: { retryable: false } });
});

test('sealed source review cannot advertise new destination claims', () => {
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'lists', {
      state: 'blocked',
      code: 'PUBLISHING_SOURCE_CLAIMS_FROZEN',
    })
  ).toMatchObject({
    state: 'needs_attention',
    actions: [],
    error: { retryable: false, message: 'This task is paused while its destination changes are reviewed.' },
  });
});

test('changed allocation source cannot advertise another create or generic resume', () => {
  expect(
    createDomainAttentionProjection({ kind: 'sermon.publish' }, 'subsplash-media', {
      state: 'blocked',
      code: 'PUBLISHING_ALLOCATION_SOURCE_CHANGED',
    })
  ).toMatchObject({
    state: 'needs_attention',
    actions: ['cancel'],
    error: { retryable: false, message: expect.stringContaining('original result') },
  });
});

test('changed metadata destinations require a new intent without generic replay', () => {
  expect(
    createDomainAttentionProjection({ kind: 'sermon.update' }, 'projection', {
      state: 'blocked',
      code: 'PUBLISHING_METADATA_DESTINATIONS_CHANGED',
    })
  ).toMatchObject({
    state: 'needs_attention',
    actions: ['cancel'],
    error: { retryable: false, message: expect.stringContaining('selected destinations changed') },
  });
});

test.each(['not_started', 'partial'])(
  'source-certified %s stop preserves content and never marks desired deletion complete',
  (providerEffects) => {
    const job: any = {
      revision: 7,
      result: { tracked: 'safe' },
      steps: [
        { id: 'delete-plan', state: 'succeeded' },
        { id: 'cleanup', state: 'succeeded' },
        { id: 'projection', state: 'running', error: { code: 'OLD' } },
        { id: 'lists', state: 'needs_attention' },
      ],
    };
    expect(
      createStoppedRepairProjection(
        job,
        { state: 'completed', mode: 'partial_stop', contentPreserved: true, providerEffects },
        123
      )
    ).toEqual({
      expectedRevision: 7,
      state: 'cancel_requested',
      actions: [],
      attention: undefined,
      error: undefined,
      result: {
        tracked: 'safe',
        resolutionPurpose: 'cleanup',
        mode: 'partial_stop',
        providerEffects,
        contentPreserved: true,
      },
      steps: [
        { id: 'projection', state: 'cancelled', finishedAt: 123 },
        { id: 'lists', state: 'cancelled', finishedAt: 123 },
      ],
    });
    expect(
      createStoppedRepairProjection(job, { state: 'completed', mode: 'partial_stop', providerEffects }, 123)
    ).toBeUndefined();
    expect(
      createStoppedRepairProjection(
        job,
        { state: 'running', mode: 'partial_stop', contentPreserved: true, providerEffects },
        123
      )
    ).toBeUndefined();
  }
);
