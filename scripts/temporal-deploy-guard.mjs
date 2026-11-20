#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firebaseAdmin, validateReleaseConfig, CONTROL_PATH } from './temporal-release-lib.mjs';

import { assertHetznerActivationReceipt, hetznerActivationPath } from './temporal-hetzner-activation.mjs';
import { assertCheckoutCommit, assertCheckoutSource } from './temporal-deploy-source.mjs';
export { assertCheckoutCommit } from './temporal-deploy-source.mjs';

export const DEPLOY_LOCK_PATH = '_control/temporalReleaseOperation';
export const DEPLOY_STATE_PATH = '_control/temporalReleaseState';
export function authorizeDeployment(control, state, release, phase) {
  if (!release) {
    if (state && state.phase !== 'complete')
      throw new Error('Automatic deployment blocked by the active controlled release');
    if ((state && (!control || state.releaseId !== control.releaseId)) || (!state && control?.releaseId))
      throw new Error('Deployment checkpoint/control mismatch requires operator inspection');
    return;
  }
  if (
    !['ui-frozen', 'ownership-changed'].includes(phase) ||
    state?.phase !== phase ||
    state.releaseId !== release.releaseId ||
    control?.releaseId !== release.releaseId ||
    control.admission !== 'paused' ||
    state.controlRevision !== control.revision ||
    state.mode !== release.mode ||
    state.compatibilityCommit !== release.compatibilityCommit ||
    state.uiCommit !== release.uiCommit ||
    JSON.stringify(state.domains) !== JSON.stringify(release.domains)
  )
    throw new Error('Controlled deployment does not match the paused immutable release checkpoint/phase');
}
export function assertHetznerYoutubeDeployCommand({ project, release, phase, child }) {
  if (
    project !== 'urm-app-staging' ||
    release?.projectId !== project ||
    phase !== 'ownership-changed' ||
    JSON.stringify(child) !== JSON.stringify(['bash', 'scripts/deploy-process-audio-hetzner.sh', 'staging'])
  )
    throw new Error('Temporal YouTube activation requires the controlled staging Hetzner deployment command');
}
export async function acquireDeploymentLock(db, { operationId, commit, release, phase, hetznerYoutubeRender }) {
  const lockRef = db.doc(DEPLOY_LOCK_PATH);
  return db.runTransaction(async (tx) => {
    const [lock, control, state] = await Promise.all([
      tx.get(lockRef),
      tx.get(db.doc(CONTROL_PATH)),
      tx.get(db.doc(DEPLOY_STATE_PATH)),
    ]);
    authorizeDeployment(control.data(), state.data(), release, phase);
    if (hetznerYoutubeRender) {
      const media = control.data()?.domains?.media;
      if (media?.owner !== 'temporal' || media.admission !== 'paused')
        throw new Error('Temporal media ownership and paused media admission are required');
      const [slot, previous] = await Promise.all([
        tx.get(db.doc('temporalYouTubeRenderHosts/staging')),
        tx.get(db.doc(hetznerActivationPath(release.releaseId))),
      ]);
      if (slot.exists) throw new Error('Staging Temporal YouTube host slot must be empty before deployment');
      if (previous.exists) throw new Error('Staging Hetzner activation already has evidence for this release');
    }
    if (lock.exists) {
      if (lock.data()?.action === 'automatic-backend-deploy') return false;
      throw new Error('Another release operation or crash recovery lock exists; inspect it before deployment');
    }
    tx.create(lockRef, {
      operationId,
      action: release ? 'controlled-backend-deploy' : 'automatic-backend-deploy',
      ...(release ? { releaseId: release.releaseId } : {}),
      commit,
      ...(hetznerYoutubeRender ? { hetznerYoutubeRender: true } : {}),
      ...(process.env.GITHUB_RUN_ID
        ? { githubRunId: process.env.GITHUB_RUN_ID, githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1' }
        : {}),
      createdAt: Date.now(),
    });
    return true;
  });
}
export async function releaseDeploymentLock(db, operationId, hetznerRelease) {
  await db.runTransaction(async (tx) => {
    const ref = db.doc(DEPLOY_LOCK_PATH),
      lock = await tx.get(ref);
    if (lock.data()?.operationId !== operationId) throw new Error('Deployment lock identity changed; refusing cleanup');
    if (hetznerRelease) {
      const [receipt, control, state] = await Promise.all([
        tx.get(db.doc(hetznerActivationPath(hetznerRelease.releaseId))),
        tx.get(db.doc(CONTROL_PATH)),
        tx.get(db.doc(DEPLOY_STATE_PATH)),
      ]);
      authorizeDeployment(control.data(), state.data(), hetznerRelease, 'ownership-changed');
      assertHetznerActivationReceipt(receipt, hetznerRelease, {
        operationId,
        controlRevision: control.data().revision,
      });
    }
    tx.delete(ref);
  });
}
export async function runGuardedCommand(
  command,
  args,
  { spawnCommand = spawn, signalSource = process, kill = process.kill, environment = process.env } = {}
) {
  let interrupted = false;
  const child = spawnCommand(command, args, { stdio: 'inherit', detached: true, env: environment });
  const forward = (signal) => {
    interrupted = true;
    if (child.pid) {
      try {
        kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };
  const term = () => forward('SIGTERM'),
    interrupt = () => forward('SIGINT');
  signalSource.on('SIGTERM', term);
  signalSource.on('SIGINT', interrupt);
  try {
    const result = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
    });
    // A failed/interrupted Firebase client may have submitted remote asynchronous work.
    // Preserve the lock for actual operation reconciliation rather than guessing completion.
    if (interrupted || result.signal || result.code !== 0)
      throw new Error('Deployment failed or was interrupted; lock retained for remote-operation inspection');
  } finally {
    signalSource.removeListener('SIGTERM', term);
    signalSource.removeListener('SIGINT', interrupt);
  }
}
async function main() {
  if (process.argv.includes('--storage-rules-repair')) {
    await (await import('./temporal-storage-rules-repair.mjs')).main(process.argv.slice(2));
    return;
  }
  const argv = process.argv.slice(2),
    separator = argv.indexOf('--');
  const options = argv.slice(0, separator),
    child = argv.slice(separator + 1);
  const value = (flag) => (options.includes(flag) ? options[options.indexOf(flag) + 1] : undefined);
  if (separator < 0 || !child.length)
    throw new Error(
      'Usage: temporal-deploy-guard.mjs --project PROJECT [--release FILE --phase ui-frozen|ownership-changed] [--materialize-function-env] [--hetzner-youtube-render] -- COMMAND ARGS...'
    );
  const release = value('--release')
    ? validateReleaseConfig(JSON.parse(await readFile(value('--release'), 'utf8')))
    : undefined;
  const project = value('--project') ?? release?.projectId;
  if (
    !['urm-app', 'urm-app-staging'].includes(project) ||
    (release && release.projectId !== project) ||
    (!release && value('--phase'))
  )
    throw new Error('Deployment guard requires the exact reviewed Firebase project/release');
  const phase = value('--phase');
  const hetznerYoutubeRender = options.includes('--hetzner-youtube-render');
  if (hetznerYoutubeRender) assertHetznerYoutubeDeployCommand({ project, release, phase, child });
  const root = resolve(new URL('..', import.meta.url).pathname);
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const commit = assertCheckoutCommit(actual, release?.compatibilityCommit ?? process.env.GITHUB_SHA ?? actual);
  const { firestore } = firebaseAdmin(project),
    operationId = randomUUID();
  let sourceControl = (await firestore.doc(CONTROL_PATH).get()).data();
  assertCheckoutSource(root, commit, {
    project,
    control: sourceControl,
    release,
    includeStagingSearch: options.includes('--include-staging-search'),
  });
  const deadline = Date.now() + 55 * 60 * 1000;
  while (!(await acquireDeploymentLock(firestore, { operationId, commit, release, phase, hetznerYoutubeRender }))) {
    if (Date.now() >= deadline) throw new Error('Automatic deployment lock remains busy; no expired lock is stolen');
    await new Promise((accept) => setTimeout(accept, 5000));
  }
  sourceControl = (await firestore.doc(CONTROL_PATH).get()).data();
  assertCheckoutSource(root, commit, {
    project,
    control: sourceControl,
    release,
    includeStagingSearch: options.includes('--include-staging-search'),
  });
  console.log(`Acquired deployment operation ${operationId} for ${project} at ${commit}.`);
  // Release only after every submitted command exits successfully. Process crashes, failed
  // commands and signals leave nonexpiring authority behind for explicit reconciliation.
  const commandEnvironment = { ...process.env, SENTRY_GIT_SHA: commit };
  delete commandEnvironment.TEMPORAL_HETZNER_DEPLOY_OPERATION_ID;
  delete commandEnvironment.TEMPORAL_HETZNER_DEPLOY_RELEASE_ID;
  if (hetznerYoutubeRender) {
    commandEnvironment.TEMPORAL_HETZNER_DEPLOY_OPERATION_ID = operationId;
    commandEnvironment.TEMPORAL_HETZNER_DEPLOY_RELEASE_ID = release.releaseId;
  }
  if (options.includes('--materialize-function-env'))
    await runGuardedCommand(
      process.execPath,
      [
        resolve(root, 'scripts/temporal-function-env.mjs'),
        '--project',
        project,
        '--from-control',
        '--commit',
        commit,
        '--apply',
        ...(options.includes('--include-staging-search')
          ? ['--include-staging-search', '--release', value('--release') ?? '']
          : []),
      ],
      { environment: commandEnvironment }
    );
  const childArguments = hetznerYoutubeRender
    ? [resolve(root, child[1]), child[2]]
    : child.slice(1);
  await runGuardedCommand(child[0], childArguments, { environment: commandEnvironment });
  assertCheckoutSource(root, commit, {
    project,
    control: sourceControl,
    release,
    includeStagingSearch: options.includes('--include-staging-search'),
  });
  await releaseDeploymentLock(firestore, operationId, hetznerYoutubeRender ? release : undefined);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
