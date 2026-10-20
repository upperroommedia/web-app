import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateCloudRunReleasePlatform } from './temporal-release-cloud-run.mjs';
import {
  renderServerlessDispatchService,
  renderServerlessDispatchWakeups,
} from './temporal-serverless-dispatch-resources.mjs';

const project = 'urm-app-staging';
const fail = () => {
  throw new Error('CLOUD_RUN_DISPATCH_CONFIGURATION_UNCONFIRMED');
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalName = (value) =>
  typeof value === 'string' ? value.replace(/^projects\/251680231116\//, 'projects/urm-app-staging/') : value;
const identical = (actual, expected) => {
  if (!isDeepStrictEqual(actual, expected)) fail();
};
function namedValues(entries) {
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => !entry || typeof entry.name !== 'string') ||
    new Set(entries.map((entry) => entry.name)).size !== entries.length
  )
    fail();
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}
function container(actual, expected) {
  if (!actual || actual.name !== expected.name || actual.image !== expected.image || actual.command?.length) fail();
  identical(actual.args, expected.args);
  identical(namedValues(actual.env), namedValues(expected.env));
  identical(actual.resources?.limits, expected.resources.limits);
  if (actual.resources?.cpuIdle !== true) fail();
  identical(actual.volumeMounts, expected.volumeMounts);
}
function reconciled(resource, service = false) {
  if (
    !resource ||
    !resource.uid ||
    !resource.etag ||
    resource.deleteTime !== undefined ||
    (resource.reconciling !== undefined && resource.reconciling !== false) ||
    !/^[1-9][0-9]*$/.test(String(resource.generation)) ||
    String(resource.observedGeneration) !== String(resource.generation) ||
    (service
      ? resource.terminalCondition?.state !== 'CONDITION_SUCCEEDED'
      : !resource.conditions?.some((c) => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED')) ||
    (resource.conditions ?? []).some((c) => c.state === 'CONDITION_FAILED')
  )
    fail();
}

/** Authenticated native configuration reads, not event delivery or scale-to-zero proof.
 * The guarded release supplies its Google transport. No invocation, IAM mutation,
 * Scheduler run or Firestore probe write occurs here. Remaining wake/recovery gates stay closed.
 */
export async function verifyCloudRunDispatchConfiguration(platform, api) {
  validateCloudRunReleasePlatform(platform);
  if (typeof api !== 'function') fail();
  const config = {
    projectId: project,
    region: 'us-central1',
    buildId: platform.workerBuildId,
    image: platform.workerImage,
    apiKeyVersion: platform.dispatch.apiKeyVersion,
  };
  const expected = renderServerlessDispatchService(config);
  try {
    const nativeService = await api(`https://run.googleapis.com/v2/${expected.name}`);
    const service = {
      ...nativeService,
      name: canonicalName(nativeService.name),
      latestReadyRevision: canonicalName(nativeService.latestReadyRevision),
      latestCreatedRevision: canonicalName(nativeService.latestCreatedRevision),
    };
    reconciled(service, true);
    if (
      service.name !== expected.name ||
      service.ingress !== expected.ingress ||
      service.invokerIamDisabled === true ||
      service.defaultUriDisabled === true ||
      service.latestCreatedRevision !== service.latestReadyRevision ||
      typeof service.latestReadyRevision !== 'string' ||
      !new RegExp(`^${expected.name}/revisions/[a-z0-9-]{1,63}$`).test(service.latestReadyRevision)
    )
      fail();
    if (
      (service.scaling?.minInstanceCount ?? 0) !== 0 ||
      service.scaling?.maxInstanceCount !== 1 ||
      (service.scaling?.scalingMode && service.scaling.scalingMode !== 'AUTOMATIC') ||
      (service.scaling?.manualInstanceCount ?? 0) !== 0
    )
      fail();
    const template = service.template;
    if (!template || template.serviceAccount !== expected.template.serviceAccount || template.containers?.length !== 1)
      fail();
    if ((template.scaling?.minInstanceCount ?? 0) !== 0 || template.scaling?.maxInstanceCount !== 1) fail();
    for (const field of ['timeout', 'maxInstanceRequestConcurrency', 'volumes'])
      identical(template[field], expected.template[field]);
    container(template.containers[0], expected.template.containers[0]);
    const revisionName = service.latestReadyRevision;
    const nativeRevision = await api(`https://run.googleapis.com/v2/${revisionName}`);
    const revision = { ...nativeRevision, name: canonicalName(nativeRevision.name) };
    reconciled(revision);
    if (
      revision.name !== revisionName ||
      revision.serviceAccount !== template.serviceAccount ||
      revision.containers?.length !== 1
    )
      fail();
    container(revision.containers[0], expected.template.containers[0]);
    identical(revision.volumes, expected.template.volumes);
    if (
      (revision.scaling?.minInstanceCount ?? 0) !== 0 ||
      revision.scaling?.maxInstanceCount !== 1 ||
      (revision.scalingStatus?.desiredMinInstanceCount ?? 0) !== 0
    )
      fail();
    for (const field of ['timeout', 'maxInstanceRequestConcurrency'])
      identical(revision[field], expected.template[field]);
    // Bind all current traffic, not just the existence of a successfully created revision.
    if (
      service.trafficStatuses?.length !== 1 ||
      ![revisionName, revisionName.split('/').at(-1)].includes(canonicalName(service.trafficStatuses[0].revision)) ||
      service.trafficStatuses[0].percent !== 100 ||
      service.trafficStatuses[0].tag
    )
      fail();
    const wakeups = renderServerlessDispatchWakeups(config, service);
    const triggers = [];
    for (const wanted of wakeups.triggers) {
      const nativeTrigger = await api(`https://eventarc.googleapis.com/v1/${wanted.name}`);
      const observed = { ...nativeTrigger, name: canonicalName(nativeTrigger.name) };
      if (
        observed.name !== wanted.name ||
        !observed.uid ||
        !observed.etag ||
        Object.keys(observed.conditions ?? {}).length ||
        Object.keys(observed.retryPolicy ?? {}).length ||
        observed.channel
      )
        fail();
      for (const field of ['serviceAccount', 'destination', 'eventDataContentType'])
        identical(observed[field], wanted[field]);
      const byAttribute = (values) => {
        if (
          !Array.isArray(values) ||
          values.length !== 3 ||
          new Set(values.map((v) => v.attribute)).size !== values.length
        )
          fail();
        return [...values].sort((a, b) => a.attribute.localeCompare(b.attribute));
      };
      identical(byAttribute(observed.eventFilters), byAttribute(wanted.eventFilters));
      const transport = observed.transport?.pubsub;
      if (
        !transport ||
        !new RegExp(`^projects/${project}/topics/[A-Za-z0-9_.~-]+$`).test(canonicalName(transport.topic) ?? '') ||
        !new RegExp(`^projects/${project}/subscriptions/[A-Za-z0-9_.~-]+$`).test(
          canonicalName(transport.subscription) ?? ''
        )
      )
        fail();
      triggers.push({ name: wanted.name, uid: observed.uid, configurationSHA256: digest(nativeTrigger) });
    }
    const nativeScheduler = await api(`https://cloudscheduler.googleapis.com/v1/${wakeups.scheduler.name}`);
    const scheduler = { ...nativeScheduler, name: canonicalName(nativeScheduler.name) };
    if (
      scheduler.name !== wakeups.scheduler.name ||
      scheduler.state !== 'ENABLED' ||
      scheduler.pubsubTarget ||
      scheduler.appEngineHttpTarget
    )
      fail();
    for (const field of ['schedule', 'timeZone', 'attemptDeadline', 'retryConfig'])
      identical(scheduler[field], wakeups.scheduler[field]);
    const target = scheduler.httpTarget;
    if (
      !target ||
      target.oauthToken ||
      target.body ||
      Object.keys(target.headers ?? {}).some((key) => !['user-agent', 'content-type'].includes(key.toLowerCase()))
    )
      fail();
    for (const field of ['uri', 'httpMethod', 'oidcToken'])
      identical(target[field], wakeups.scheduler.httpTarget[field]);
    const policy = await api(
      `https://run.googleapis.com/v2/${expected.name}:getIamPolicy?options.requestedPolicyVersion=3`
    );
    if (!policy?.etag || policy.bindings?.length !== 1) fail();
    const grant = policy.bindings[0];
    if (
      Object.keys(grant).some((key) => !['role', 'members'].includes(key)) ||
      grant.role !== 'roles/run.invoker' ||
      !Array.isArray(grant.members) ||
      grant.members.length !== 2 ||
      new Set(grant.members).size !== 2 ||
      !wakeups.serviceInvokerGrant.members.every((member) => grant.members.includes(member))
    )
      fail();
    return {
      schemaVersion: 1,
      projectId: project,
      buildId: platform.workerBuildId,
      observedAt: new Date().toISOString(),
      service: {
        name: service.name,
        uid: service.uid,
        revision: revision.name,
        revisionUid: revision.uid,
        image: platform.workerImage,
        runner: template.serviceAccount,
        configurationSHA256: digest(nativeService),
      },
      triggers,
      scheduler: { name: scheduler.name, configurationSHA256: digest(nativeScheduler) },
      directInvokerPolicySHA256: digest(policy),
      scope: 'native configuration and direct invocation policy only; delivery and effective access unproved',
    };
  } catch {
    return fail();
  }
}
