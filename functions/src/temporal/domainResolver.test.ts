import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  createDurableDomainResolver,
  validateIntentionalResourceAdoption,
  type DomainResolutionDependencies,
  type DurableDomainResolutionInput,
  type DurableResolutionCommitHooks,
} from './domainResolver';
import {
  providerPayloadFingerprint,
  providerReceiptId,
  providerAcknowledgementFingerprint,
} from './publishing/providerReceipts';
import {
  durableEntityKey,
  durableActivityDrainKey,
  type DurableActivityExecution,
} from '@upperroom/orchestration/job-store';

function setup(kind = 'sermon.publish') {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = { jobId: 'job1', projectId: 'staging' };
  const entity = { type: 'sermon' as const, id: 'sermon1' };
  docs.set('durableJobs/job1', {
    schemaVersion: 1,
    ...ref,
    kind,
    entity,
    requestedBy: 'editor1',
    generation: 1,
    revision: 5,
    state: 'needs_attention',
    actions: ['resolve', 'cancel'],
    steps: [],
    createdAt: 1,
    updatedAt: 1,
  });
  docs.set('durableJobIntents/job1', {
    schemaVersion: 1,
    ...ref,
    kind,
    entity,
    actorUid: 'editor1',
    generation: 1,
    payload: {},
    createdAt: 1,
  });
  docs.set(`durableJobEntities/${durableEntityKey('staging', entity, kind as never)}`, {
    schemaVersion: 1,
    projectId: 'staging',
    entity,
    generation: 1,
    activeJobId: 'job1',
  });
  docs.set('temporalProviderReceipts/receipt1', {
    operationKey: 'durable:staging:job1:publish',
    state: 'needs_review',
  });
  docs.set('durableEmailReceipts/job1', { token: 'private-attempt-token', state: 'unknown' });
  const snapshot = (path: string) => ({
    exists: docs.has(path),
    data: () => structuredClone(docs.get(path)),
    get: (key: string) => docs.get(path)?.[key],
  });
  const document = (path: string) => ({ path, id: path.split('/').pop()!, get: async () => snapshot(path) });
  let tail: Promise<unknown> = Promise.resolve();
  const firestore = {
    collection: (name: string) => ({ doc: (id: string) => document(`${name}/${id}`) }),
    runTransaction: <T>(callback: (tx: Transaction) => Promise<T>) => {
      const run = tail.then(async () => {
        let written = false;
        const writes: Array<() => void> = [];
        const tx = {
          get: async (target: { path: string }) => {
            if (written) throw new Error('Read after write');
            return snapshot(target.path);
          },
          set: (target: { path: string }, value: Record<string, unknown>) => {
            written = true;
            writes.push(() => docs.set(target.path, structuredClone(value)));
          },
          create: (target: { path: string }, value: Record<string, unknown>) => {
            written = true;
            writes.push(() => {
              if (docs.has(target.path)) throw new Error('Duplicate');
              docs.set(target.path, structuredClone(value));
            });
          },
          update: (target: { path: string }, value: Record<string, unknown>) => {
            written = true;
            writes.push(() => {
              docs.set(target.path, { ...docs.get(target.path), ...structuredClone(value) });
            });
          },
        };
        const result = await callback(tx as unknown as Transaction);
        writes.forEach((write) => write());
        return result;
      });
      tail = run.catch(() => undefined);
      return run;
    },
  } as unknown as Firestore;
  const fenceCommit = async (input: {
    fence(tx: Transaction): Promise<void>;
    commit(tx: Transaction): Promise<void>;
  }) => {
    await firestore.runTransaction(async (tx) => {
      await input.fence(tx);
      await input.commit(tx);
    });
  };
  const deps: DomainResolutionDependencies = {
    firestore,
    projectId: 'staging',
    getActor: jest.fn(async () => ({ disabled: false, customClaims: { role: 'admin' } })),
    publishing: jest.fn(fenceCommit),
    image: jest.fn(fenceCommit),
    email: jest.fn(async (input) => {
      await firestore.runTransaction(async (tx) => {
        await input.fence(tx);
        await input.commit(tx, { state: 'confirmed' });
      });
      return { state: 'confirmed' as const };
    }),
  };
  const input = {
    actorUid: 'admin1',
    jobId: 'job1',
    requestId: 'review1',
    expectedRevision: 5,
    resolution: {
      receiptId: 'receipt1',
      remoteId: 'remote1',
      decision: 'adopt_existing_resource',
      duplicateRiskAcknowledged: true,
      evidenceReference: 'provider-log-123',
      reason: 'Adopt the selected compatible resource after reviewing provider logs.',
    },
  };
  const rawResolve = createDurableDomainResolver(deps);
  const resolve = (request: DurableDomainResolutionInput, hooks?: DurableResolutionCommitHooks) =>
    rawResolve(
      request,
      hooks ?? {
        prepareCommand: async (tx, resolved) => {
          await tx.get(firestore.collection('durableJobs').doc(request.jobId));
          return () => {
            tx.create(firestore.collection('durableJobCommands').doc(request.requestId), { signal: resolved.signal });
            return {
              projectId: 'staging',
              jobId: request.jobId,
              requestId: request.requestId,
              state: 'accepted',
              acceptedRevision: request.expectedRevision,
            } as const;
          };
        },
      }
    );
  return { docs, deps, input, resolve, rawResolve };
}

describe('reviewed durable domain resolution', () => {
  test('rejects implicit adoption, missing acknowledgement and unaudited review', () => {
    expect(() => validateIntentionalResourceAdoption({ remoteId: 'id' })).toThrow('acknowledge');
    expect(() =>
      validateIntentionalResourceAdoption({
        decision: 'adopt_existing_resource',
        remoteId: 'id',
        duplicateRiskAcknowledged: true,
      })
    ).toThrow('reference');
  });
  test('fresh administrator authorization is required even for jobs owned by another actor', async () => {
    const { deps, input, resolve } = setup();
    (deps.getActor as jest.Mock).mockResolvedValue({ disabled: false, customClaims: { role: 'editor' } });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(deps.publishing).not.toHaveBeenCalled();
  });
  test('successful explicit adoption records private review and keeps job revision unchanged', async () => {
    const { docs, deps, input, resolve } = setup();
    expect(await resolve(input)).toMatchObject({ signal: { name: 'publishingResume', args: [] } });
    expect(docs.get('durableJobs/job1')?.revision).toBe(5);
    expect(deps.getActor).toHaveBeenCalledTimes(3);
    const audit = [...docs].find(([key]) => key.startsWith('durableJobResolutionRequests/'))?.[1];
    expect(audit).toMatchObject({
      state: 'completed',
      actorUid: 'admin1',
      decision: {
        decision: 'adopt_existing_resource',
        duplicateRiskAcknowledged: true,
        evidenceReference: 'provider-log-123',
      },
    });
  });
  test('private cancellation authority restricts publishing review to cleanup and is fenced after verification', async () => {
    const { docs, deps, input, resolve } = setup();
    docs.get('durableJobs/job1')!.workflowId = 'publishing:job1';
    docs.set('durableJobCancellationIntents/job1', {
      projectId: 'staging',
      workflowId: 'publishing:job1',
      generation: 1,
      actorUid: 'admin1',
    });
    deps.publishing = jest.fn(async (value) => {
      expect(value.cleanupOnly).toBe(true);
      docs.get('durableJobCancellationIntents/job1')!.actorUid = 'different-admin';
      await deps.firestore.runTransaction(async (tx) => {
        await value.fence(tx);
        await value.commit(tx);
      });
    });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'aborted' });
    expect([...docs].find(([key]) => key.startsWith('durableJobResolutionRequests/'))?.[1].state).toBe('verifying');
  });
  test('foreign cancellation authority cannot grant reviewed cleanup', async () => {
    const { docs, deps, input, resolve } = setup();
    docs.set('durableJobCancellationIntents/job1', { projectId: 'production', generation: 1 });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(deps.publishing).not.toHaveBeenCalled();
  });
  test('lost command response replays the same audited resolution without provider verification again', async () => {
    const { deps, input, resolve } = setup();
    const first = await resolve(input);
    expect(await resolve(input)).toEqual(first);
    expect(deps.publishing).toHaveBeenCalledTimes(1);
    await expect(
      resolve({ ...input, resolution: { ...input.resolution, remoteId: 'different' } })
    ).rejects.toMatchObject({ code: 'already-exists' });
  });
  test('foreign receipts cannot be adopted even by an administrator', async () => {
    const { docs, deps, input, resolve } = setup();
    docs.set('temporalProviderReceipts/receipt1', { operationKey: 'durable:staging:other-job:publish' });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(deps.publishing).not.toHaveBeenCalled();
  });
  test('provider owner/content verification rejection cannot complete the review', async () => {
    const { docs, deps, input, resolve } = setup();
    (deps.publishing as jest.Mock).mockRejectedValue(new Error('Wrong provider account'));
    await expect(resolve(input)).rejects.toThrow('Wrong provider account');
    expect([...docs].find(([key]) => key.startsWith('durableJobResolutionRequests/'))?.[1].state).toBe('verifying');
  });
  test('job revision change during provider GET prevents final receipt commit', async () => {
    const { docs, deps, input, resolve } = setup();
    let committed = false;
    deps.publishing = jest.fn(async (value) => {
      docs.get('durableJobs/job1')!.revision = 6;
      await deps.firestore.runTransaction(async (tx) => {
        await value.fence(tx);
        committed = true;
      });
    });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'aborted' });
    expect(committed).toBe(false);
  });
  test('new generation during verification prevents the previous job receipt commit', async () => {
    const { docs, deps, input, resolve } = setup();
    deps.publishing = jest.fn(async (value) => {
      const entityHead = [...docs].find(([key]) => key.startsWith('durableJobEntities/'))![1];
      entityHead.generation = 2;
      entityHead.activeJobId = 'replacement';
      await deps.firestore.runTransaction(async (tx) => {
        await value.fence(tx);
      });
    });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'STALE_GENERATION' });
  });
  test('administrator revoked during external verification is refused before receipt writes', async () => {
    const { deps, input, resolve } = setup();
    (deps.getActor as jest.Mock)
      .mockResolvedValueOnce({ disabled: false, customClaims: { role: 'admin' } })
      .mockResolvedValue({ disabled: true, customClaims: { role: 'admin' } });
    await expect(resolve(input)).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('email review obtains receipt token privately and requires duplicate acknowledgement to resend', async () => {
    const { deps, input, resolve } = setup('email.deliver');
    const resolution = {
      decision: 'resend_after_review',
      duplicateRiskAcknowledged: true,
      evidenceReference: 'mail-provider-log',
      reason: 'Resend after administrator review.',
    };
    (deps.email as jest.Mock).mockImplementation(async (value) => {
      await deps.firestore.runTransaction(async (tx) => {
        await value.fence(tx);
        await value.commit(tx, { state: 'resent', replacementJobId: 'replacement-mail' });
      });
      return { state: 'resent', replacementJobId: 'replacement-mail' };
    });
    expect(await resolve({ ...input, resolution })).toMatchObject({
      signal: { name: 'emailResume', args: [] },
      replacementJobRef: { projectId: 'staging', jobId: 'replacement-mail' },
    });
    expect(deps.email).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedReceiptToken: 'private-attempt-token',
        expectedRevision: 5,
        expectedGeneration: 1,
      })
    );
    await expect(
      resolve({
        ...input,
        requestId: 'invalid-token',
        resolution: { ...resolution, expectedReceiptToken: 'browser-input' },
      })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      resolve({ ...input, requestId: 'no-ack', resolution: { ...resolution, duplicateRiskAcknowledged: false } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
  test('receipt adoption and resume command roll back together when final commit fails', async () => {
    const { docs, deps, input, resolve } = setup();
    deps.publishing = jest.fn(async (value) => {
      await deps.firestore.runTransaction(async (tx) => {
        await value.fence(tx);
        await value.commit(tx);
        tx.update(deps.firestore.collection('temporalProviderReceipts').doc('receipt1'), {
          state: 'confirmed',
          remoteId: 'remote1',
        });
        throw new Error('Injected failure before atomic commit');
      });
    });
    await expect(
      resolve(input, {
        prepareCommand: async (tx, result) => {
          await tx.get(deps.firestore.collection('durableJobCommands').doc('command1'));
          return () => {
            const receipt = {
              jobId: 'job1',
              projectId: 'staging',
              requestId: 'review1',
              acceptedRevision: 6,
              state: 'accepted' as const,
            };
            tx.create(deps.firestore.collection('durableJobCommands').doc('command1'), {
              state: 'pending',
              signal: result.signal,
            });
            tx.update(deps.firestore.collection('durableJobs').doc('job1'), { revision: 6, state: 'reconciling' });
            return receipt;
          };
        },
      })
    ).rejects.toThrow('Injected failure');
    expect(docs.get('temporalProviderReceipts/receipt1')?.state).toBe('needs_review');
    expect(docs.get('durableJobs/job1')?.revision).toBe(5);
    expect(docs.has('durableJobCommands/command1')).toBe(false);
    expect([...docs].find(([key]) => key.startsWith('durableJobResolutionRequests/'))?.[1].state).toBe('verifying');
  });
  test('successful final commit adopts receipt and enqueues resume under one transaction', async () => {
    const { docs, deps, input, resolve } = setup();
    deps.publishing = jest.fn(async (value) => {
      await deps.firestore.runTransaction(async (tx) => {
        await value.fence(tx);
        await value.commit(tx);
        tx.update(deps.firestore.collection('temporalProviderReceipts').doc('receipt1'), {
          state: 'confirmed',
          remoteId: 'remote1',
        });
      });
    });
    const resolved = await resolve(input, {
      prepareCommand: async (tx, result) => {
        await tx.get(deps.firestore.collection('durableJobCommands').doc('command1'));
        return () => {
          const receipt = {
            jobId: 'job1',
            projectId: 'staging',
            requestId: 'review1',
            acceptedRevision: 6,
            state: 'accepted' as const,
          };
          tx.create(deps.firestore.collection('durableJobCommands').doc('command1'), {
            state: 'pending',
            signal: result.signal,
          });
          tx.update(deps.firestore.collection('durableJobs').doc('job1'), { revision: 6, state: 'reconciling' });
          return receipt;
        };
      },
    });
    expect(resolved.commandReceipt?.acceptedRevision).toBe(6);
    expect(docs.get('temporalProviderReceipts/receipt1')?.state).toBe('confirmed');
    expect(docs.get('durableJobCommands/command1')?.state).toBe('pending');
    expect(docs.get('durableJobs/job1')?.revision).toBe(6);
    expect((await resolve(input)).commandReceipt).toEqual(resolved.commandReceipt);
  });
  test('image review uses its own job receipt and the image resume signal', async () => {
    const { deps, input, resolve } = setup('image.ingest');
    expect(
      await resolve({
        ...input,
        resolution: { ...input.resolution, decision: 'retain_existing_resource', receiptId: 'job1' },
      })
    ).toMatchObject({ signal: { name: 'image.resume', args: [] } });
    expect(deps.image).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 5, expectedGeneration: 1 }));
  });
  test('operator review cannot authorize PUT overwriting an uncertain shared image allocation', async () => {
    const { deps, input, resolve } = setup('image.ingest');
    await expect(resolve({ ...input, resolution: { ...input.resolution, receiptId: 'job1' } })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(deps.image).not.toHaveBeenCalled();
  });
  test('speaker approval provider review resumes its account workflow, not entity publishing', async () => {
    const { docs, input, resolve } = setup('speaker.resolve');
    docs.get('durableJobIntents/job1')!.payload = { action: 'speaker-accept' };
    expect(await resolve(input)).toMatchObject({ signal: { name: 'accountResume', args: [] } });
  });

  test('known-resource retention prepares permanent index protection and immutable audit in the atomic reviewed command', async () => {
    const { docs, deps, input, resolve } = setup();
    docs.get('durableJobs/job1')!.workflowId = 'publishing:job1';
    docs.set('durableJobCancellationIntents/job1', {
      projectId: 'staging',
      workflowId: 'publishing:job1',
      generation: 1,
    });
    docs.get('temporalProviderReceipts/receipt1')!.state = 'confirmed';
    Object.assign(docs.get('temporalProviderReceipts/receipt1')!, {
      result: 'remote1',
      fingerprint: 'private-payload-fingerprint',
      revision: 2,
    });
    const apply = jest.fn();
    deps.prepareKnownRetention = jest.fn(async () => ({
      resource: { projectId: 'staging', provider: 'subsplash' as const, account: 'app:9XTSHD', remoteId: 'remote1' },
      commit: apply,
    }));
    await resolve({ ...input, resolution: { ...input.resolution, decision: 'retain_existing_resource' } });
    expect(apply).toHaveBeenCalledTimes(1);
    expect([...docs].find(([path]) => path.startsWith('temporalProviderRetentions/'))?.[1]).toMatchObject({
      decision: 'retain_existing_resource',
      remoteId: 'remote1',
      receiptRevision: 3,
      resource: { remoteId: 'remote1' },
    });
  });
  test('unknown or different confirmed resources cannot be classified as already retained', async () => {
    const { docs, deps, input, resolve } = setup();
    docs.get('durableJobs/job1')!.workflowId = 'publishing:job1';
    docs.set('durableJobCancellationIntents/job1', {
      projectId: 'staging',
      workflowId: 'publishing:job1',
      generation: 1,
    });
    await expect(
      resolve({ ...input, resolution: { ...input.resolution, decision: 'retain_existing_resource' } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(deps.publishing).not.toHaveBeenCalled();
  });
  test.each(['retain_existing_resource', 'confirm_existing_resource_absent'])(
    'ordinary shared-image cleanup routes %s through the atomic dedicated reviewer',
    async (decision) => {
      const { docs, deps, input, resolve } = setup('image.delete');
      docs.get('durableJobIntents/job1')!.payload = { operation: 'delete', imageId: 'local-image' };
      deps.imageDeletion = jest.fn(async (value) => {
        await deps.firestore.runTransaction(async (tx) => {
          await value.fence(tx);
          await value.commit(tx);
        });
      });
      const resolution = {
        decision,
        remoteId: 'remote1',
        duplicateRiskAcknowledged: true,
        evidenceReference: 'image-review-123',
        reason: 'Review this exact shared image without forced deletion.',
      };
      expect(await resolve({ ...input, resolution })).toMatchObject({ signal: { name: 'image.resume', args: [] } });
      expect(deps.imageDeletion).toHaveBeenCalledWith(
        expect.objectContaining({ review: expect.objectContaining({ decision }) })
      );
      expect(deps.image).not.toHaveBeenCalled();
    }
  );
  test('ordinary shared-image cleanup rejects adoption and force-delete decisions', async () => {
    const { docs, deps, input, resolve } = setup('image.delete');
    docs.get('durableJobIntents/job1')!.payload = { operation: 'delete', imageId: 'local-image' };
    deps.imageDeletion = jest.fn();
    await expect(
      resolve({ ...input, resolution: { ...input.resolution, receiptId: undefined } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      resolve({
        ...input,
        requestId: 'forced',
        resolution: { ...input.resolution, decision: 'delete_existing_resource', receiptId: undefined },
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(deps.imageDeletion).not.toHaveBeenCalled();
  });
  function accountFixture() {
    const fixture = setup('role.assign');
    const { docs, deps } = fixture;
    const entity = { type: 'user' as const, id: 'target1' };
    const claims = { role: 'publisher', temporalAccountClaimJobId: 'job1', otherFeature: true };
    const execution: DurableActivityExecution = {
      workflowId: 'workflow:job1',
      runId: 'run1',
      activityId: '3',
      activityType: 'applyAccountClaims',
      scheduledAt: 1000,
      attempt: 1,
      runStartedAtNanos: '1000000000001',
      temporalNamespace: 'staging',
      worker: {
        instanceId: 'instance1',
        buildId: 'build1',
        podUid: 'pod1',
        podName: 'worker-pod',
        namespace: 'workers',
        clusterId: 'cluster1',
        nodeUid: 'node1',
        nodeName: 'worker-node',
        containerIds: ['containerd://one'],
      },
    };
    docs.get('durableJobs/job1')!.entity = entity;
    docs.get('durableJobs/job1')!.workflowId = execution.workflowId;
    docs.get('durableJobIntents/job1')!.entity = entity;
    docs.get('durableJobIntents/job1')!.payload = {
      action: 'role-assign',
      assignmentId: 'assignment1',
      targetUid: 'target1',
      role: 'publisher',
    };
    docs.set(`durableJobEntities/${durableEntityKey('staging', entity, 'role.assign')}`, {
      projectId: 'staging',
      entity,
      generation: 1,
      activeJobId: 'job1',
    });
    docs.set('_durableAccountAssignments/assignment1', {
      targetUid: 'target1',
      temporalJobId: 'job1',
      temporalClaimsRequestedJobId: 'job1',
    });
    const resourcePath = `_durableAccountClaimResources/${createHash('sha256')
      .update('staging:target1')
      .digest('hex')}`;
    docs.set(resourcePath, {
      projectId: 'staging',
      uid: 'target1',
      jobId: 'job1',
      state: 'started',
      transport: 'single_shot_identity_toolkit',
      claims,
      execution,
    });
    const proofPath = `durableActivityDrains/${durableActivityDrainKey('staging', 'job1', execution)}`;
    docs.set(proofPath, {
      schemaVersion: 1,
      projectId: 'staging',
      jobId: 'job1',
      executionId: createHash('sha256')
        .update(JSON.stringify([execution.workflowId, execution.runId, execution.activityId, execution.scheduledAt]))
        .digest('hex'),
      execution,
      state: 'drained',
      source: 'worker_settled',
      drainedAt: 2000,
    });
    deps.getActor = jest.fn(async (uid) =>
      uid === 'target1'
        ? { disabled: false, customClaims: claims }
        : { disabled: false, customClaims: { role: 'admin' } }
    );
    const input = {
      ...fixture.input,
      resolution: {
        decision: 'confirm_access_applied',
        evidenceReference: 'auth-review-123',
        reason: 'Confirm the observed applied account change after the originating caller stopped.',
      },
    };
    return { ...fixture, input, execution, proofPath, resourcePath, claims };
  }
  test('confirms exact applied Auth claims only after an originating execution witness', async () => {
    const { docs, input, resolve, resourcePath } = accountFixture();
    expect(await resolve(input)).toMatchObject({ signal: { name: 'accountResume', args: [] } });
    expect(docs.get(resourcePath)?.state).toBe('applied');
    expect(docs.get('_durableAccountAssignments/assignment1')?.temporalClaimsAppliedJobId).toBe('job1');
    expect((await resolve(input)).signal.name).toBe('accountResume');
  });
  test('missing origin witness prevents even the target Auth observation and leaves its resource blocked', async () => {
    const { docs, deps, input, resolve, proofPath, resourcePath } = accountFixture();
    docs.delete(proofPath);
    await expect(resolve(input)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(deps.getActor).not.toHaveBeenCalledWith('target1');
    expect(docs.get(resourcePath)?.state).toBe('started');
  });
  test('contradictory claims or a missing positive operation marker never reset or retry Auth', async () => {
    const { docs, deps, input, resolve, resourcePath } = accountFixture();
    deps.getActor = jest.fn(async (uid) => ({
      disabled: false,
      customClaims: uid === 'target1' ? { role: 'publisher' } : { role: 'admin' },
    }));
    await expect(resolve(input)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(docs.get(resourcePath)?.state).toBe('started');
    expect(docs.get('_durableAccountAssignments/assignment1')?.temporalClaimsAppliedJobId).toBeUndefined();
  });
  test('a multi-attempt SDK transport cannot be released using a single observed marker', async () => {
    const { docs, input, resolve, resourcePath } = accountFixture();
    docs.get(resourcePath)!.transport = 'firebase_admin_sdk';
    await expect(resolve(input)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(docs.get(resourcePath)?.state).toBe('started');
  });
  test('execution witness from another worker instance cannot authorize Auth recovery', async () => {
    const { docs, input, resolve, proofPath, resourcePath } = accountFixture();
    const proof = docs.get(proofPath)!;
    proof.execution = {
      ...(proof.execution as DurableActivityExecution),
      worker: { ...(proof.execution as DurableActivityExecution).worker!, instanceId: 'another-worker' },
    };
    await expect(resolve(input)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(docs.get(resourcePath)?.state).toBe('started');
  });
  test('Auth recovery receipt, checkpoint, audit and resume command roll back together on a commit gap', async () => {
    const { docs, deps, input, resolve, resourcePath } = accountFixture();
    await expect(
      resolve(input, {
        prepareCommand: async (tx, result) => {
          await tx.get(deps.firestore.collection('durableJobCommands').doc('account-command'));
          return () => {
            tx.create(deps.firestore.collection('durableJobCommands').doc('account-command'), {
              signal: result.signal,
              state: 'pending',
            });
            throw new Error('Injected account resume commit gap');
          };
        },
      })
    ).rejects.toThrow('Injected account resume commit gap');
    expect(docs.get(resourcePath)?.state).toBe('started');
    expect(docs.get('_durableAccountAssignments/assignment1')?.temporalClaimsAppliedJobId).toBeUndefined();
    expect(docs.has('durableJobCommands/account-command')).toBe(false);
  });
  test('operator termination proof never claims that its remote Auth RPC has completed', async () => {
    const { docs, input, resolve, proofPath, execution } = accountFixture();
    const proof = docs.get(proofPath)!;
    proof.source = 'operator_verified_pod_termination';
    proof.operatorUid = 'google:operator-subject';
    proof.evidenceReference = 'durableAccountExecutionAudits/audit1';
    proof.attestation = {
      kind: 'verified_pod_termination',
      projectId: 'staging',
      temporalNamespace: 'staging',
      ...execution.worker,
      kubePodResourceVersion: '20',
      kubeNodeResourceVersion: '30',
      namespaceUid: 'namespace1',
      evidenceDigest: 'evidence-sha',
      googleOperator: { subject: 'operator-subject' },
      kubernetesOperator: { username: 'operator', groups: ['operators'] },
      remoteRpcCompletionProven: false,
      verifiedAt: 2000,
    };
    expect((await resolve(input)).signal.name).toBe('accountResume');
    const second = accountFixture();
    const secondProof = second.docs.get(second.proofPath)!;
    Object.assign(secondProof, {
      source: proof.source,
      operatorUid: proof.operatorUid,
      evidenceReference: proof.evidenceReference,
      attestation: { ...(proof.attestation as Record<string, unknown>), remoteRpcCompletionProven: true },
    });
    await expect(second.resolve({ ...second.input, requestId: 'incorrect-claim' })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(second.docs.get(second.resourcePath)?.state).toBe('started');
  });

  function sessionFixture() {
    const fixture = accountFixture();
    const execution = {
      ...fixture.execution,
      activityType: 'revokeAccountSessions',
      activityId: '4',
      scheduledAt: 3000,
    };
    const proofPath = `durableActivityDrains/${durableActivityDrainKey('staging', 'job1', execution)}`;
    fixture.docs.set(proofPath, {
      schemaVersion: 1,
      projectId: 'staging',
      jobId: 'job1',
      executionId: createHash('sha256')
        .update(JSON.stringify([execution.workflowId, execution.runId, execution.activityId, execution.scheduledAt]))
        .digest('hex'),
      execution,
      state: 'drained',
      source: 'worker_settled',
      drainedAt: 4000,
    });
    const sessionClaims = {
      ...fixture.claims,
      temporalAccountSessionOperationId: '123e4567-e89b-42d3-a456-426614174000',
    };
    Object.assign(fixture.docs.get(fixture.resourcePath)!, {
      sessionClaims,
      sessionOperationId: '123e4567-e89b-42d3-a456-426614174000',
      state: 'applied',
      sessionState: 'started',
      sessionCutoffSeconds: '1700000000',
      sessionExecution: execution,
      sessionTransport: 'single_shot_identity_toolkit',
    });
    fixture.docs.get('_durableAccountAssignments/assignment1')!.temporalClaimsAppliedJobId = 'job1';
    fixture.deps.getActor = jest.fn(async (uid) =>
      uid === 'target1'
        ? {
            disabled: false,
            customClaims: sessionClaims,
            tokensValidAfterTime: new Date(1700000000 * 1000).toUTCString(),
          }
        : { disabled: false, customClaims: { role: 'admin' } }
    );
    return {
      ...fixture,
      proofPath,
      input: { ...fixture.input, resolution: { ...fixture.input.resolution, decision: 'confirm_sessions_revoked' } },
    };
  }
  test('observed frozen session revocation and bound drain proof commit checkpoint with resume atomically', async () => {
    const { docs, input, resolve, resourcePath } = sessionFixture();
    expect(await resolve(input)).toMatchObject({ signal: { name: 'accountResume', args: [] } });
    expect(docs.get(resourcePath)).toMatchObject({
      state: 'applied',
      sessionState: 'applied',
      sessionCutoffSeconds: '1700000000',
    });
    expect(docs.get('_durableAccountAssignments/assignment1')?.temporalSessionsRevokedJobId).toBe('job1');
  });
  test('missing session witness and earlier observed cutoff never release the serialized account resource', async () => {
    const first = sessionFixture();
    first.docs.delete(first.proofPath);
    await expect(first.resolve(first.input)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(first.deps.getActor).not.toHaveBeenCalledWith('target1');
    const second = sessionFixture();
    second.deps.getActor = jest.fn(async (uid) =>
      uid === 'target1'
        ? {
            disabled: false,
            customClaims: second.docs.get(second.resourcePath)!.sessionClaims as Record<string, unknown>,
            tokensValidAfterTime: new Date(1699999999 * 1000).toUTCString(),
          }
        : { disabled: false, customClaims: { role: 'admin' } }
    );
    await expect(second.resolve(second.input)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(second.docs.get(second.resourcePath)?.sessionState).toBe('started');
  });
  test('a preexisting cutoff without this unique session marker cannot prove the originating RPC completed', async () => {
    const { docs, deps, input, resolve, resourcePath, claims } = sessionFixture();
    deps.getActor = jest.fn(async (uid) =>
      uid === 'target1'
        ? { disabled: false, customClaims: claims, tokensValidAfterTime: new Date(1900000000 * 1000).toUTCString() }
        : { disabled: false, customClaims: { role: 'admin' } }
    );
    await expect(resolve(input)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(docs.get(resourcePath)?.sessionState).toBe('started');
    expect(docs.get('_durableAccountAssignments/assignment1')?.temporalSessionsRevokedJobId).toBeUndefined();
    expect([...docs].some(([path]) => path.startsWith('durableJobCommands/'))).toBe(false);
    // The previously pending remote request becomes uniquely observable later.
    deps.getActor = jest.fn(async (uid) =>
      uid === 'target1'
        ? {
            disabled: false,
            customClaims: docs.get(resourcePath)!.sessionClaims as Record<string, unknown>,
            tokensValidAfterTime: new Date(1900000000 * 1000).toUTCString(),
          }
        : { disabled: false, customClaims: { role: 'admin' } }
    );
    expect(await resolve(input)).toMatchObject({ signal: { name: 'accountResume', args: [] } });
    expect(docs.get(resourcePath)?.sessionState).toBe('applied');
  });
  test('session review command failure rolls back revocation checkpoint and resource settlement', async () => {
    const { docs, input, resolve, resourcePath } = sessionFixture();
    await expect(
      resolve(input, {
        prepareCommand: async () => () => {
          throw new Error('session command gap');
        },
      })
    ).rejects.toThrow('session command gap');
    expect(docs.get(resourcePath)?.sessionState).toBe('started');
    expect(docs.get('_durableAccountAssignments/assignment1')?.temporalSessionsRevokedJobId).toBeUndefined();
  });
  test('claims reconciliation reserves sessions atomically and retains a higher frozen previous cutoff', async () => {
    const { docs, input, resolve, resourcePath } = accountFixture();
    docs.get(resourcePath)!.sessionCutoffSeconds = '4102444800';
    await resolve(input);
    expect(docs.get(resourcePath)).toMatchObject({
      state: 'applied',
      sessionState: 'pending',
      sessionCutoffSeconds: '4102444800',
    });
  });
});

describe('additional acknowledged allocation disposition', () => {
  function orphanFixture() {
    const fixture = setup();
    fixture.docs.get('durableJobs/job1')!.workflowId = 'publishing:job1';
    fixture.docs.set('durableJobCancellationIntents/job1', {
      projectId: 'staging',
      workflowId: 'publishing:job1',
      generation: 1,
      actorUid: 'admin1',
    });
    const fact = {
      schemaVersion: 1,
      projectId: 'staging',
      jobId: 'job1',
      receiptId: 'receipt1',
      step: 'subsplash-audio',
      attemptOwner: 'original-attempt',
      claimRevision: 1,
      payloadFingerprint: 'original-payload',
      remoteId: 'additional-audio',
      disposition: 'orphaned',
      acknowledgedAtMillis: 100,
    };
    const acknowledgementId = createHash('sha256')
      .update(JSON.stringify([fact.receiptId, fact.attemptOwner, fact.claimRevision, fact.remoteId]))
      .digest('hex');
    const factPath = `temporalProviderAcknowledgements/${acknowledgementId}`;
    fixture.docs.set(factPath, fact);
    fixture.docs.set('temporalProviderReceipts/receipt1', {
      operationKey: 'durable:staging:job1:publish',
      projectId: 'staging',
      jobId: 'job1',
      step: fact.step,
      fingerprint: fact.payloadFingerprint,
      state: 'confirmed',
      result: 'selected-audio',
    });
    fixture.deps.verifyOrphanResource = jest.fn(async () => 'additional-audio');
    fixture.deps.prepareOrphanDisposition = jest.fn(async () => ({
      resource: {
        projectId: 'staging',
        provider: 'subsplash' as const,
        account: 'app:9XTSHD',
        remoteId: 'additional-audio',
      },
      commit: jest.fn(),
    }));
    const input = {
      ...fixture.input,
      resolution: {
        acknowledgementId,
        decision: 'retain_orphan',
        duplicateRiskAcknowledged: true,
        evidenceReference: 'provider-log-extra',
        reason: 'Retain the additional allocation after reviewing ownership and cost.',
      },
    };
    return { ...fixture, factPath, fact, acknowledgementId, input };
  }
  test('verified explicit retention records a distinct disposition and resumes cancellation atomically', async () => {
    const { docs, input, resolve, factPath, fact, acknowledgementId } = orphanFixture();
    expect(await resolve(input)).toMatchObject({ signal: { name: 'publishingResume', args: [] } });
    expect(docs.get(factPath)).toMatchObject({
      ...fact,
      review: { decision: 'retain_after_review', duplicateRiskAcknowledged: true, actorUid: 'admin1' },
    });
    expect(docs.get(`temporalProviderAcknowledgementReviews/${acknowledgementId}`)?.decision).toBe(
      'retain_after_review'
    );
    expect(docs.get('temporalProviderReceipts/receipt1')?.result).toBe('selected-audio');
  });
  test('foreign or changed allocation facts and missing duplicate acknowledgement cannot authorize retention', async () => {
    const foreign = orphanFixture();
    foreign.docs.get(foreign.factPath)!.jobId = 'other';
    await expect(foreign.resolve(foreign.input)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(foreign.deps.verifyOrphanResource).not.toHaveBeenCalled();
    const changed = orphanFixture();
    changed.deps.verifyOrphanResource = jest.fn(async () => {
      changed.docs.get(changed.factPath)!.remoteId = 'late-other';
      return 'additional-audio';
    });
    await expect(changed.resolve(changed.input)).rejects.toMatchObject({ code: 'aborted' });
    expect(changed.docs.get(changed.factPath)?.review).toBeUndefined();
    const missing = orphanFixture();
    await expect(
      missing.resolve({
        ...missing.input,
        resolution: { ...missing.input.resolution, duplicateRiskAcknowledged: false },
      })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  test('failed resume commit leaves allocation fact, disposition and selected canonical evidence unchanged', async () => {
    const { docs, input, resolve, factPath, fact, acknowledgementId } = orphanFixture();
    await expect(
      resolve(input, {
        prepareCommand: async () => () => {
          throw new Error('orphan command gap');
        },
      })
    ).rejects.toThrow('orphan command gap');
    expect(docs.get(factPath)).toEqual(fact);
    expect(docs.has(`temporalProviderAcknowledgementReviews/${acknowledgementId}`)).toBe(false);
  });
  test('fixed original acknowledged resource absence can settle only its own reviewed disposition', async () => {
    const fixture = orphanFixture();
    fixture.deps.verifyOrphanAbsent = jest.fn(async () => true);
    const input = { ...fixture.input, resolution: { ...fixture.input.resolution, decision: 'confirm_orphan_cleanup' } };
    await fixture.resolve(input);
    expect(fixture.deps.verifyOrphanResource).not.toHaveBeenCalled();
    expect(fixture.deps.prepareOrphanDisposition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ decision: 'cleanup_verified' })
    );
    expect(fixture.docs.get(fixture.factPath)).toMatchObject({
      remoteId: 'additional-audio',
      review: { decision: 'cleanup_verified' },
    });
    expect(fixture.docs.get('temporalProviderReceipts/receipt1')?.result).toBe('selected-audio');
  });
  test('resource existence or index protection rejection prevents an orphan-cleanup settlement', async () => {
    const exists = orphanFixture();
    exists.deps.verifyOrphanAbsent = jest.fn(async () => false);
    await expect(
      exists.resolve({
        ...exists.input,
        resolution: { ...exists.input.resolution, decision: 'confirm_orphan_cleanup' },
      })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(exists.docs.get(exists.factPath)?.review).toBeUndefined();
    const protectedFixture = orphanFixture();
    protectedFixture.deps.prepareOrphanDisposition = jest.fn(async () => {
      throw new Error('canonical references remain');
    });
    await expect(protectedFixture.resolve(protectedFixture.input)).rejects.toThrow('canonical references remain');
    expect(protectedFixture.docs.get(protectedFixture.factPath)?.review).toBeUndefined();
  });
});

describe('certified critical repair approval', () => {
  function criticalFixture() {
    const f = setup();
    const certificateId = 'c'.repeat(64);
    f.docs.get('durableJobs/job1')!.workflowId = 'publishing:job1';
    f.docs.get('durableJobs/job1')!.attention = {
      kind: 'permission_changed',
      message: 'Approve repair',
      resolutionKind: 'critical_repair',
      certificateId,
      repairPurpose: 'complete_fixed_cleanup',
    };
    const certificate = {
      schemaVersion: 1 as const,
      projectId: 'staging',
      jobId: 'job1',
      generation: 1,
      workflowId: 'publishing:job1',
      acceptedUserCancellation: false,
      intentFingerprint: 'a'.repeat(64),
      criticalFingerprint: 'b'.repeat(64),
      operations: [],
      sourceEvidenceDigests: [],
    };
    f.deps.prepareCriticalRepair = jest.fn(async (tx) => ({
      certificate,
      certificateId,
      digest: certificateId,
      commit: () => {
        tx.create(f.deps.firestore.collection('temporalPublishingCriticalRepairs').doc(certificateId), { certificate });
      },
    }));
    const input = {
      ...f.input,
      resolution: {
        decision: 'continue_critical_repair',
        certificateId,
        evidenceReference: 'operator-review-42',
        reason: 'Complete the certified fixed cleanup.',
      },
    };
    return { ...f, input, certificateId };
  }
  test('certificate, fresh admin grant, command and resume are committed together', async () => {
    const f = criticalFixture();
    const result = await f.resolve(f.input, {
      prepareCommand: async (tx, resolved) => {
        expect(resolved).toMatchObject({
          cleanupOnly: true,
          criticalRepairCertificateId: f.certificateId,
          signal: { name: 'publishingCriticalRepair' },
        });
        await tx.get(f.deps.firestore.collection('durableJobs').doc('job1'));
        return () => {
          tx.create(f.deps.firestore.collection('durableJobCommands').doc('critical'), { signal: resolved.signal });
          return { jobId: 'job1', revision: 6, accepted: true } as never;
        };
      },
    });
    expect(result.criticalRepairCertificateId).toBe(f.certificateId);
    expect(f.docs.get('durableJobCriticalRepairGrants/job1')).toMatchObject({
      actorUid: 'admin1',
      certificateId: f.certificateId,
      operations: [],
    });
    expect(f.docs.has('durableJobCommands/critical')).toBe(true);
    expect(f.docs.has(`temporalPublishingCriticalRepairs/${f.certificateId}`)).toBe(true);
  });
  test('revision advancement after the review audit aborts before source planning or grant writes', async () => {
    const f = criticalFixture();
    const transact = f.deps.firestore.runTransaction.bind(f.deps.firestore);
    let advanced = false;
    f.deps.firestore.runTransaction = (async (invoke: Parameters<typeof transact>[0]) => {
      const result = await transact(invoke);
      if (
        !advanced &&
        [...f.docs].some(
          ([path, record]) => path.startsWith('durableJobResolutionRequests/') && record.state === 'verifying'
        )
      ) {
        advanced = true;
        f.docs.get('durableJobs/job1')!.revision = 6;
      }
      return result;
    }) as typeof f.deps.firestore.runTransaction;
    await expect(f.resolve(f.input)).rejects.toMatchObject({ code: 'aborted' });
    expect(f.deps.prepareCriticalRepair).not.toHaveBeenCalled();
    expect(f.docs.has('durableJobCriticalRepairGrants/job1')).toBe(false);
    expect(f.docs.has(`temporalPublishingCriticalRepairs/${f.certificateId}`)).toBe(false);
  });
  test('source-certified legacy retention requires explicit acknowledgement and pins only source IDs', async () => {
    const f = criticalFixture();
    const sourceId = 'e'.repeat(64);
    const sourceOperation = {
      kind: 'legacy_soundcloud_retain',
      certificateId: sourceId,
    } as unknown as import('./publishing/criticalRepair').FixedRepairOperation;
    const prepare = f.deps.prepareCriticalRepair!;
    f.deps.prepareCriticalRepair = async (tx, input) => {
      const planned = await prepare(tx, input);
      return { ...planned, certificate: { ...planned.certificate, operations: [sourceOperation] } };
    };
    await expect(f.resolve(f.input)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(f.docs.has('durableJobCriticalRepairGrants/job1')).toBe(false);
    expect(f.docs.has('durableJobCommands/review1')).toBe(false);
    const reviewed = {
      ...f.input,
      requestId: 'acknowledged-retention',
      resolution: { ...f.input.resolution, retentionAcknowledged: true },
    };
    await f.resolve(reviewed);
    expect(f.docs.get('durableJobCriticalRepairGrants/job1')).toMatchObject({
      retentionAcknowledged: true,
      sourceCertificateIds: [sourceId],
      operations: [sourceOperation],
    });
    expect(f.docs.has('durableJobCommands/acknowledged-retention')).toBe(true);
    await expect(
      f.resolve({
        ...reviewed,
        requestId: 'substituted',
        resolution: { ...reviewed.resolution, sourceCertificateIds: ['f'.repeat(64)] },
      })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  test('command failure rolls back certificate and grant; forged certificate is rejected', async () => {
    const f = criticalFixture();
    await expect(
      f.resolve(f.input, {
        prepareCommand: async () => () => {
          throw new Error('command unavailable');
        },
      })
    ).rejects.toThrow('command unavailable');
    expect(f.docs.has('durableJobCriticalRepairGrants/job1')).toBe(false);
    expect(f.docs.has(`temporalPublishingCriticalRepairs/${f.certificateId}`)).toBe(false);
    await expect(
      f.resolve({
        ...f.input,
        requestId: 'different',
        resolution: { ...f.input.resolution, certificateId: 'd'.repeat(64) },
      })
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('independent orphan review after the original operation completes', () => {
  function fixture() {
    const f = setup('provider.orphan_review');
    const operationKey = 'durable:staging:original:publish';
    const receiptId = providerReceiptId(operationKey, 'subsplash-audio');
    const account = { provider: 'subsplash' as const, account: 'app:9XTSHD' };
    const fact = {
      schemaVersion: 1 as const,
      projectId: 'staging',
      jobId: 'original',
      receiptId,
      step: 'subsplash-audio',
      attemptOwner: 'original-attempt',
      claimRevision: 1,
      payloadFingerprint: 'original-payload',
      remoteId: 'orphan-audio',
      disposition: 'orphaned' as const,
      acknowledgedAtMillis: 100,
      providerAccount: account,
    };
    const acknowledgementId = providerPayloadFingerprint([
      receiptId,
      fact.attemptOwner,
      fact.claimRevision,
      fact.remoteId,
    ]);
    const childId = providerPayloadFingerprint(['provider-orphan-review', 'staging', acknowledgementId]);
    const entity = { type: 'maintenance' as const, id: `provider-orphan-${childId}` };
    const child = {
      ...f.docs.get('durableJobs/job1')!,
      jobId: childId,
      entity,
      workflowId: `provider-ack-review:staging:${childId}`,
      actions: ['resolve'],
    };
    f.docs.set(`durableJobs/${childId}`, child);
    f.docs.set(`durableJobEntities/${durableEntityKey('staging', entity, 'provider.orphan_review')}`, {
      schemaVersion: 1,
      projectId: 'staging',
      entity,
      generation: 1,
      activeJobId: childId,
    });
    f.docs.set(`durableJobIntents/${childId}`, {
      ...f.docs.get('durableJobIntents/job1')!,
      jobId: childId,
      entity,
      payload: {
        schemaVersion: 1,
        sourceJobId: 'original',
        sourceAcknowledgementId: acknowledgementId,
        acknowledgementFingerprint: providerAcknowledgementFingerprint(fact),
      },
    });
    f.docs.set('durableJobs/original', { jobId: 'original', state: 'cancelled', revision: 10 });
    f.docs.set('durableJobIntents/original', { projectId: 'staging', jobId: 'original', actorUid: 'editor1' });
    f.docs.set(`temporalProviderAcknowledgements/${acknowledgementId}`, fact);
    f.docs.set(`temporalProviderReceipts/${receiptId}`, {
      projectId: 'staging',
      jobId: 'original',
      operationKey,
      step: fact.step,
      fingerprint: fact.payloadFingerprint,
      providerAccount: account,
    });
    f.deps.verifyOrphanResource = jest.fn(async () => ({ id: fact.remoteId }));
    f.deps.prepareOrphanDisposition = jest.fn(async (_tx, input) => {
      expect(input.ref.jobId).toBe('original');
      return {
        resource: {
          projectId: 'staging',
          provider: 'subsplash' as const,
          account: 'app:9XTSHD',
          remoteId: fact.remoteId,
        },
        commit: () => {},
      };
    });
    const input = {
      ...f.input,
      jobId: childId,
      resolution: {
        acknowledgementId,
        decision: 'retain_orphan',
        duplicateRiskAcknowledged: true,
        evidenceReference: 'provider-review',
        reason: 'Retain the original additional allocation.',
      },
    };
    return { ...f, childId, acknowledgementId, input };
  }
  test('reviews the immutable original allocation but resumes only the independent child', async () => {
    const f = fixture();
    expect(await f.resolve(f.input)).toMatchObject({ signal: { name: 'providerOrphanReviewResume', args: [] } });
    expect(f.docs.get('durableJobs/original')).toEqual({ jobId: 'original', state: 'cancelled', revision: 10 });
    expect(f.docs.get(`temporalProviderAcknowledgementReviews/${f.acknowledgementId}`)).toMatchObject({
      jobId: 'original',
      reviewCaseJobId: f.childId,
    });
  });
  test('immutable child fingerprint tampering prevents verification and disposition', async () => {
    const f = fixture();
    (f.docs.get(`durableJobIntents/${f.childId}`)!.payload as Record<string, unknown>).acknowledgementFingerprint =
      'a'.repeat(64);
    await expect(f.resolve(f.input)).rejects.toThrow('immutable evidence changed');
    expect(f.deps.verifyOrphanResource).not.toHaveBeenCalled();
    expect(f.deps.prepareOrphanDisposition).not.toHaveBeenCalled();
  });
});

test('domain resolution refuses receipt mutations without an atomic command coordinator', async () => {
  const f = setup();
  await expect(f.rawResolve(f.input)).rejects.toMatchObject({ code: 'failed-precondition' });
  expect(f.deps.publishing).not.toHaveBeenCalled();
  expect([...f.docs.keys()].some((key) => key.startsWith('durableJobResolutionRequests/'))).toBe(false);
});
