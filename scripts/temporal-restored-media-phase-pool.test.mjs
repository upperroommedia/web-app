import test from 'node:test';
import assert from 'node:assert/strict';
import { activateRestoredCloudRunMedia } from './temporal-media-restored-activation.mjs';
import { restoredMediaPhaseExpectation } from './temporal-restored-media-phase-pool.mjs';
import { restoredActivationFixture } from './tests/fixtures/restored-media-activation.mjs';
async function states(cleanup = false) {
  const f = restoredActivationFixture(),
    all = [],
    save = f.options.save;
  f.options.save = async (s) => {
    all.push(structuredClone(s));
    return save(s);
  };
  if (cleanup)
    f.options.runtime.registration = async () => {
      throw Error('CONTROLLED unused');
    };
  try {
    await activateRestoredCloudRunMedia(f.options);
  } catch {
    assert.ok(cleanup);
  }
  return all;
}
const retained = await states(),
  cleaned = await states(true);
const scope = (s, key) => ({
  plan: s.plan,
  state: s,
  key,
  transition: (key === 'retained' || key === 'stopped' ? s.start : s[key]) ?? null,
});
for (const stage of ['before-attempt', 'attempted', 'acknowledged', 'completed'])
  test('start exact source phase ' + stage, () => {
    const s = retained.find((s) => (s.start?.stage ?? 'before-attempt') === stage);
    const p = restoredMediaPhaseExpectation(scope(s, 'start'));
    assert.equal(p.stage, stage);
    assert.equal(p.before.desiredManualInstanceCount, 0);
    assert.equal(p.target, 1);
    if (stage === 'attempted') assert.equal(p.nativeOperation, undefined);
  });
for (const stage of ['before-attempt', 'attempted', 'acknowledged', 'completed'])
  test('stop exact source phase ' + stage, () => {
    const s = cleaned.find((s) => s.cleanup && (s.stop?.stage ?? 'before-attempt') === stage);
    const p = restoredMediaPhaseExpectation(scope(s, 'stop'));
    assert.equal(p.stage, stage);
    assert.equal(p.before.desiredManualInstanceCount, 1);
    assert.equal(p.target, 0);
  });
test('retained and stopped use distinct completed source facts', () => {
  assert.equal(restoredMediaPhaseExpectation(scope(retained.at(-1), 'retained')).exact.desiredManualInstanceCount, 1);
  assert.equal(restoredMediaPhaseExpectation(scope(cleaned.at(-1), 'stopped')).exact.desiredManualInstanceCount, 0);
});
for (const [name, change] of [
  [
    'foreign saved transition',
    (s) => {
      s.transition = { ...s.transition, attemptedAt: new Date().toISOString() };
    },
  ],
  [
    'other plan',
    (s) => {
      s.plan = { ...s.plan, createdAt: '2000-01-01T00:00:00.000Z' };
    },
  ],
  [
    'cleanup before start',
    (s) => {
      s.key = 'start';
      s.state = structuredClone(cleaned.at(-1));
      s.plan = s.state.plan;
      s.transition = s.state.start;
    },
  ],
  [
    'stop without unused decision',
    (s) => {
      s.key = 'stop';
      s.transition = null;
    },
  ],
  [
    'unavailable phase',
    (s) => {
      s.key = 'diagnostic';
    },
  ],
])
  test(name + ' denies', () => {
    const x = scope(structuredClone(retained.at(-1)), 'retained');
    change(x);
    assert.throws(() => restoredMediaPhaseExpectation(x));
  });
