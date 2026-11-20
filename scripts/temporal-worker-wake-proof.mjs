const fail = () => {
  throw new Error('CLOUD_RUN_WORKER_WAKE_UNCONFIRMED');
};

/** Join prior observations only. This performs no workflow start or pool mutation. */
export function proveWorkerWake({ phase, event, expected, telemetry, audit, beforeInstance, after, zeroAfter }) {
  const { role, poolUid, revisionUid, revision, image, maxInstances } = expected;
  const { eligibleAt, startedAt, workerIdentity } = event;
  if (
    !['timer', 'retry'].includes(phase) ||
    telemetry.role !== role ||
    telemetry.poolUid !== poolUid ||
    telemetry.revisionUid !== revisionUid ||
    telemetry.revision !== revision ||
    telemetry.declaredImage !== image ||
    ![eligibleAt, startedAt, after, zeroAfter].every(Number.isFinite) ||
    eligibleAt >= startedAt ||
    startedAt > after ||
    after >= zeroAfter ||
    !Number.isSafeInteger(maxInstances) ||
    maxInstances < 1 ||
    !Array.isArray(telemetry.samples) ||
    !Array.isArray(audit)
  )
    fail();

  const start = telemetry.start;
  const samples = telemetry.samples;
  if (
    !start ||
    !Number.isFinite(start.at) ||
    typeof start.instanceId !== 'string' ||
    !start.instanceId ||
    start.workerIdentity !== workerIdentity ||
    typeof beforeInstance !== 'string' ||
    !beforeInstance ||
    start.instanceId === beforeInstance ||
    start.at < eligibleAt ||
    start.at > startedAt ||
    samples.some(
      ({ at, count }, i) =>
        !Number.isFinite(at) ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > maxInstances ||
        (i !== 0 && at <= samples[i - 1].at)
    )
  )
    fail();

  const zeroBefore = samples.findLast(({ at }) => at < eligibleAt);
  if (!zeroBefore || zeroBefore.count !== 0 || eligibleAt - zeroBefore.at > 120000) fail();
  const drain = samples.find(({ at, count }) => at >= zeroAfter && count === 0);
  if (!drain) fail();

  const changes = audit.filter(({ at }) => at >= zeroBefore.at && at <= drain.at);
  if (changes.length !== 2) fail();
  const [scaleOut, scaleIn] = changes;
  if (
    scaleOut.at < eligibleAt ||
    scaleOut.at > start.at ||
    !Number.isSafeInteger(scaleOut.count) ||
    scaleOut.count < 1 ||
    scaleOut.count > maxInstances ||
    scaleIn.count !== 0 ||
    scaleIn.at < after ||
    scaleIn.at >= drain.at ||
    !samples.some(({ at, count }) => at >= start.at && at < scaleIn.at && count > 0) ||
    samples.some(({ at, count }) => at > zeroBefore.at && at < scaleOut.at && count > 0)
  )
    fail();

  return { phase, role, poolUid, revision, revisionUid, workerIdentity, zeroBefore, start, scaleOut, scaleIn, drain };
}
