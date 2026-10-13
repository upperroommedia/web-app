import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { capacityWorkflow, probeState, requestProbe } from './control-capacity.fixture';
async function eventually(predicate: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 150; n++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Capacity fixture did not reach expected state');
}
test('dedicated controls remain responsive while all ten provider slots are occupied', async () => {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    for (const separate of [false, true]) {
      const providerQueue = `providers-${separate}`,
        controlQueue = separate ? 'urm-controls' : providerQueue;
      let started = 0,
        probed = false,
        release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const occupied = async () => {
        started++;
        await gate;
      };
      const probe = async () => {
        probed = true;
      };
      const providers = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: providerQueue,
        workflowsPath: require.resolve('./control-capacity.fixture'),
        maxConcurrentActivityTaskExecutions: 10,
        activities: { occupied, probe },
      });
      const controls = separate
        ? await Worker.create({ connection: env.nativeConnection, taskQueue: controlQueue, activities: { probe } })
        : undefined;
      const exercise = async () => {
        const handle = await env.client.workflow.start(capacityWorkflow, {
          workflowId: `capacity-${separate}`,
          taskQueue: providerQueue,
          args: [{ providerQueue, controlQueue }],
        });
        try {
          await eventually(() => started === 10);
          await handle.signal(requestProbe);
          await eventually(async () => (await handle.query(probeState)).requested);
          if (separate) {
            await eventually(() => probed);
            expect(started).toBe(10); // None of the occupied provider activities has settled.
          } else {
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(probed).toBe(false);
          }
        } finally {
          release();
          await handle.result();
        }
      };
      await providers.runUntil(() => (controls ? controls.runUntil(exercise) : exercise()));
    }
  } finally {
    await env.teardown();
  }
}, 120000);
