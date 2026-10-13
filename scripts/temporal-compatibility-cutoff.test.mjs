import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import {
  compatibilityCutoffUpdates,
  compatibilitySettlingDeadline,
  assertCompatibilitySettlingCheckpoint,
  assertCompatibilityGraceElapsed,
  hasCompatibilitySettlingCheckpoint,
  nativeCompatibilityTimestamp,
} from './temporal-compatibility-cutoff.mjs';
const { Timestamp } = createRequire(new URL('../functions/package.json', import.meta.url))('firebase-admin/firestore');
const config = { mode: 'initial-cutover', releaseId: 'release', legacyExecutionGraceSeconds: 3600 };
const cutoff = new Timestamp(1791913009, 856938000);
function checkpoint() {
  return {
    control: { legacyAdmissionCutoff: cutoff },
    state: {
      mode: 'initial-cutover',
      compatibilityVerifiedAt: cutoff,
      legacySettlingCutoff: cutoff,
      legacySettlingGraceSeconds: 3600,
      maximumLegacyExecutionSeconds: 3570,
    },
  };
}
test('derive the full grace from exact native cutoff with upward millisecond rounding', () => {
  assert.equal(compatibilitySettlingDeadline(cutoff, 3600), 1791916609857);
  assert.equal(compatibilitySettlingDeadline({ seconds: 1, nanoseconds: 0 }, 1), 2000);
  assert.equal(compatibilitySettlingDeadline({ seconds: 1, nanoseconds: 1 }, 1), 2001);
  assert.equal(compatibilitySettlingDeadline({ seconds: 1, nanoseconds: 999999999 }, 1), 3000);
  for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => compatibilitySettlingDeadline(cutoff, bad));
  assert.throws(() => compatibilitySettlingDeadline({ seconds: 253402300799, nanoseconds: 999999999 }, 9007199254740));
});
test('initial transaction uses identical server transforms for control, state cutoff and readiness', () => {
  const sentinel = {},
    updates = compatibilityCutoffUpdates({}, 'initial-cutover', 3600, () => sentinel);
  assert.equal(updates.controlUpdate.legacyAdmissionCutoff, sentinel);
  assert.equal(updates.stateUpdate.legacySettlingCutoff, sentinel);
  assert.equal(updates.stateUpdate.compatibilityVerifiedAt, sentinel);
  assert.equal(updates.stateUpdate.legacySettlingGraceSeconds, 3600);
  assert.equal(Object.hasOwn(updates.stateUpdate, 'legacySettlingDeadline'), false);
});
test('any existing initial cutoff is rejected before it can be restamped; durable mode preserves it', () => {
  for (const value of [cutoff, null, 1, { seconds: 1, nanoseconds: 0, extra: true }]) {
    let called = false;
    assert.throws(
      () =>
        compatibilityCutoffUpdates({ legacyAdmissionCutoff: value }, 'initial-cutover', 3600, () => {
          called = true;
        }),
      /cannot be reset/
    );
    assert.equal(called, false);
  }
  const updates = compatibilityCutoffUpdates(
    { legacyAdmissionCutoff: cutoff },
    'durable-upgrade',
    undefined,
    () => cutoff
  );
  assert.deepEqual(updates.controlUpdate, {});
});
test('mismatched native pins, numeric workstation timestamps and reduced grace fail closed', () => {
  const changes = [
    (state) => (state.legacySettlingCutoff = new Timestamp(cutoff.seconds, cutoff.nanoseconds + 1)),
    (state) => (state.compatibilityVerifiedAt = Date.now()),
    (state) => (state.legacySettlingGraceSeconds = 3599),
    (state) => (state.maximumLegacyExecutionSeconds = 3601),
    (state) => (state.maximumLegacyExecutionSeconds = NaN),
    (state) => (state.legacySettlingDeadline = 1791916609856),
    (state) => (state.legacySettlingCutoff = { seconds: cutoff.seconds, nanoseconds: cutoff.nanoseconds, extra: true }),
  ];
  for (const mutate of changes) {
    const f = checkpoint();
    mutate(f.state);
    assert.throws(() => assertCompatibilitySettlingCheckpoint(f.control, f.state, config));
  }
  const f = checkpoint();
  f.state.legacySettlingDeadline = 1791916609857;
  assert.equal(assertCompatibilitySettlingCheckpoint(f.control, f.state, config), 1791916609857);
  for (const value of [
    { seconds: 1, nanoseconds: -1 },
    { seconds: 1, nanoseconds: 1e9 },
    { _seconds: 1, _nanoseconds: 0 },
    { seconds: 253402300800, nanoseconds: 0 },
  ])
    assert.throws(() => nativeCompatibilityTimestamp(value));
});
test('server readTime enforces the entire grace despite fast or slow workstation clocks and submillisecond edges', () => {
  const f = checkpoint(),
    original = Date.now;
  try {
    for (const clock of [0, Number.MAX_SAFE_INTEGER]) {
      Date.now = () => clock;
      assert.throws(() =>
        assertCompatibilityGraceElapsed(f.control, f.state, config, new Timestamp(1791916609, 856999999))
      );
      assert.equal(
        assertCompatibilityGraceElapsed(f.control, f.state, config, new Timestamp(1791916609, 857000000)),
        1791916609857
      );
    }
  } finally {
    Date.now = original;
  }
});
test('durable upgrade stamps only readiness, creates no cutoff and retains zero-grace server readiness', () => {
  const sentinel = {},
    updates = compatibilityCutoffUpdates({}, 'durable-upgrade', undefined, () => sentinel);
  assert.deepEqual(updates.controlUpdate, {});
  assert.deepEqual(updates.stateUpdate, { compatibilityVerifiedAt: sentinel });
  const cfg = { mode: 'durable-upgrade' },
    state = { mode: 'durable-upgrade', compatibilityVerifiedAt: cutoff };
  assert.equal(assertCompatibilitySettlingCheckpoint({}, state, cfg), 1791913009857);
  assert.throws(() => assertCompatibilityGraceElapsed({}, state, cfg, new Timestamp(1791913009, 856000000)));
  assert.equal(assertCompatibilityGraceElapsed({}, state, cfg, new Timestamp(1791913009, 857000000)), 1791913009857);
  assert.throws(() => compatibilityCutoffUpdates({}, 'unknown', 3600, () => {}));
});
test('mode-aware detection preserves pre-readiness pause and initial cutoff protections', () => {
  for (const phase of ['ui-frozen', 'freezing-ui'])
    assert.equal(hasCompatibilitySettlingCheckpoint({}, { mode: 'initial-cutover', phase }, config), false);
  assert.equal(
    hasCompatibilitySettlingCheckpoint(
      {},
      { mode: 'initial-cutover', phase: 'paused-for-recovery', pausedFrom: 'ui-frozen' },
      config
    ),
    false
  );
  assert.equal(
    hasCompatibilitySettlingCheckpoint(
      {},
      { mode: 'initial-cutover', phase: 'paused-for-recovery', pausedFrom: 'compatibility-ready' },
      config
    ),
    true
  );
  assert.equal(
    hasCompatibilitySettlingCheckpoint(
      { legacyAdmissionCutoff: null },
      { mode: 'initial-cutover', phase: 'ui-frozen' },
      config
    ),
    true
  );
  for (const phase of ['compatibility-ready', 'legacy-drained', 'ownership-changed', 'ui-ready', 'open', 'complete'])
    assert.equal(hasCompatibilitySettlingCheckpoint({}, { mode: 'initial-cutover', phase }, config), true);
  assert.throws(
    () => hasCompatibilitySettlingCheckpoint({}, { mode: 'durable-upgrade', phase: 'ui-frozen' }, config),
    /mode/
  );
});
test('a new durable upgrade ignores the origin initial cutoff until its own native readiness is committed', () => {
  const cfg = { mode: 'durable-upgrade' },
    control = { legacyAdmissionCutoff: cutoff };
  for (const phase of ['freezing-ui', 'ui-frozen'])
    assert.equal(hasCompatibilitySettlingCheckpoint(control, { mode: cfg.mode, phase }, cfg), false);
  assert.equal(
    hasCompatibilitySettlingCheckpoint(
      control,
      { mode: cfg.mode, phase: 'paused-for-recovery', pausedFrom: 'ui-frozen' },
      cfg
    ),
    false
  );
  const ready = new Timestamp(cutoff.seconds + 7200, 0),
    state = { mode: cfg.mode, phase: 'compatibility-ready', compatibilityVerifiedAt: ready };
  assert.equal(hasCompatibilitySettlingCheckpoint(control, state, cfg), true);
  assert.equal(assertCompatibilityGraceElapsed(control, state, cfg, ready), (cutoff.seconds + 7200) * 1000);
  assert.equal(control.legacyAdmissionCutoff, cutoff);
  for (const phase of ['compatibility-ready', 'legacy-drained', 'ownership-changed', 'ui-ready', 'open', 'complete'])
    assert.equal(hasCompatibilitySettlingCheckpoint(control, { mode: cfg.mode, phase }, cfg), true);
  assert.throws(
    () => assertCompatibilitySettlingCheckpoint(control, { ...state, mode: 'initial-cutover' }, cfg),
    /mode/
  );
});
const cli = await readFile(new URL('./temporal-release.mjs', import.meta.url), 'utf8');
const transitionSource = cli.slice(cli.indexOf('async function transition('), cli.indexOf('\nfunction requirePhase('));
function transactionFixture({ race, crash, mode = 'initial-cutover' } = {}) {
  const controlRef = { path: 'control' },
    stateRef = { path: 'state' },
    lockRef = { path: 'lock' },
    sentinel = { server: true };
  const control = {
    schemaVersion: 1,
    releaseId: 'release',
    revision: 4,
    admission: 'paused',
    domains: { media: { owner: 'legacy', admission: 'paused' } },
  };
  const state = {
    mode,
    releaseId: 'release',
    phase: 'ui-frozen',
    controlRevision: 4,
    maximumLegacyExecutionSeconds: 3570,
  };
  const initial = { control, state, lock: { operationId: 'op', releaseId: 'release', action: 'compatibility-ready' } };
  if (mode === 'durable-upgrade') {
    control.legacyAdmissionCutoff = new Timestamp(cutoff.seconds - 7200, 0);
    control.domains.media.owner = 'temporal';
  }
  if (race === 'revision') initial.control.revision = 5;
  if (race === 'lock') initial.lock.operationId = 'other';
  if (race === 'phase') initial.state.phase = 'compatibility-ready';
  if (race === 'cutoff') initial.control.legacyAdmissionCutoff = cutoff;
  if (race === 'null-cutoff') initial.control.legacyAdmissionCutoff = null;
  const stored = new Map(Object.entries(initial)),
    writes = [];
  const snap = (ref) => ({ data: () => stored.get(ref.path), readTime: new Timestamp(cutoff.seconds - 30, 0) });
  const firestore = {
    runTransaction: async (callback) => {
      const pending = [];
      await callback({ get: async (ref) => snap(ref), update: (ref, data) => pending.push([ref, data]) });
      if (crash === 'before') throw Error('crash before atomic commit');
      for (const [ref, data] of pending) {
        const resolved = Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, value === sentinel ? cutoff : value])
        );
        stored.set(ref.path, { ...stored.get(ref.path), ...resolved });
        writes.push({ path: ref.path, data: resolved });
      }
      if (crash === 'after') throw Error('uncertain response after atomic commit');
    },
  };
  const ctx = {
    firestore,
    controlRef,
    stateRef,
    lockRef,
    operationId: 'op',
    action: 'compatibility-ready',
    config: { ...config, mode },
    compatibilityCutoffUpdates,
    hasCompatibilitySettlingCheckpoint,
    assertCompatibilitySettlingCheckpoint,
    assertCompatibilityGraceElapsed,
    serverTimestamp: () => sentinel,
    Date: { now: () => 0 },
  };
  vm.createContext(ctx);
  const transition = vm.runInContext(transitionSource + '\ntransition', ctx);
  return { stored, writes, transition };
}
test('actual release transition atomically pins full server grace after delayed commit, without owner/admission writes', async () => {
  const f = transactionFixture();
  await f.transition(4, 'compatibility-ready', {
    legacySettlingGraceSeconds: 3600,
    compatibilityEvidenceAt: '2026-10-13T17:35:00Z',
  });
  const c = f.stored.get('control'),
    s = f.stored.get('state');
  assert.equal(c.legacyAdmissionCutoff, cutoff);
  assert.equal(s.legacySettlingCutoff, cutoff);
  assert.equal(s.compatibilityVerifiedAt, cutoff);
  assert.equal(c.revision, 5);
  assert.equal(s.phase, 'compatibility-ready');
  assert.equal(compatibilitySettlingDeadline(c.legacyAdmissionCutoff, s.legacySettlingGraceSeconds), 1791916609857);
  assert.equal(Object.hasOwn(s, 'legacySettlingDeadline'), false);
  assert.equal(c.domains.media.owner, 'legacy');
  assert.equal(c.admission, 'paused');
  assert.equal(
    f.writes.some((w) => Object.hasOwn(w.data, 'domains') || Object.hasOwn(w.data, 'admission')),
    false
  );
});
test('actual release CAS rejects revision, lock, phase and grace races before writing', async () => {
  for (const race of ['revision', 'lock', 'phase', 'cutoff', 'null-cutoff']) {
    const f = transactionFixture({ race });
    await assert.rejects(f.transition(4, 'compatibility-ready', { legacySettlingGraceSeconds: 3600 }));
    assert.deepEqual(f.writes, []);
  }
  const f = transactionFixture();
  await assert.rejects(f.transition(4, 'compatibility-ready', { legacySettlingGraceSeconds: 3569 }));
  assert.deepEqual(f.writes, []);
});
test('crash has either no cutoff or complete atomic server pins; no partial phase and no owner writes', async () => {
  for (const crash of ['before', 'after']) {
    const f = transactionFixture({ crash });
    await assert.rejects(f.transition(4, 'compatibility-ready', { legacySettlingGraceSeconds: 3600 }));
    const c = f.stored.get('control'),
      s = f.stored.get('state');
    assert.equal(c.domains.media.owner, 'legacy');
    assert.equal(c.admission, 'paused');
    if (crash === 'before') {
      assert.equal(Object.hasOwn(c, 'legacyAdmissionCutoff'), false);
      assert.equal(s.phase, 'ui-frozen');
      assert.deepEqual(f.writes, []);
    } else {
      assert.equal(s.phase, 'compatibility-ready');
      assert.equal(assertCompatibilitySettlingCheckpoint(c, s, config), 1791916609857);
      await assert.rejects(f.transition(5, 'compatibility-ready', { legacySettlingGraceSeconds: 3600 }));
      assert.equal(c.legacyAdmissionCutoff, cutoff);
    }
  }
});

test('actual durable readiness transition preserves origin cutoff and stamps only its new zero-grace readiness', async () => {
  const f = transactionFixture({ mode: 'durable-upgrade' }),
    origin = f.stored.get('control').legacyAdmissionCutoff;
  await f.transition(4, 'compatibility-ready', { compatibilityEvidenceAt: '2026-10-13T17:35:00Z' });
  const c = f.stored.get('control'),
    s = f.stored.get('state');
  assert.equal(c.legacyAdmissionCutoff, origin);
  assert.equal(s.compatibilityVerifiedAt, cutoff);
  assert.equal(s.phase, 'compatibility-ready');
  assert.equal(Object.hasOwn(s, 'legacySettlingCutoff'), false);
  assert.equal(Object.hasOwn(s, 'legacySettlingGraceSeconds'), false);
  assert.equal(
    assertCompatibilityGraceElapsed(c, s, { mode: 'durable-upgrade' }, new Timestamp(cutoff.seconds, 857000000)),
    1791913009857
  );
  assert.equal(c.domains.media.owner, 'temporal');
});
