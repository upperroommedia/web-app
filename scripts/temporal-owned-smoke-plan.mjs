/** Pure incident planning only. No database, credentials, provider transport or apply entrypoint. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { proofDigest } from './temporal-release-runtime.mjs';

const incident = JSON.parse(
  readFileSync(new URL('../ops/temporal/owned-smoke-incident.staging.json', import.meta.url))
);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
export const OWNED_SMOKE_INCIDENT = freeze(incident);
const same = (a, b) => proofDigest(a) === proofDigest(b);
const key = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const resourceKey = (r) => key([r.projectId, r.provider, r.account, r.remoteId]);
const requireThat = (condition, code) => {
  if (!condition) throw Object.assign(new Error(`OWNED_SMOKE_${code}`), { code: `OWNED_SMOKE_${code}` });
};
const onlyKeys = (value, keys) =>
  value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort());
const validStamp = (v) =>
  onlyKeys(v, ['seconds', 'nanoseconds']) &&
  Number.isSafeInteger(v.seconds) &&
  Number.isInteger(v.nanoseconds) &&
  v.nanoseconds >= 0 &&
  v.nanoseconds < 1e9;

function assertDocument(row, path) {
  requireThat(
    row &&
      typeof path === 'string' &&
      row.path === path &&
      row.data &&
      typeof row.data === 'object' &&
      !Array.isArray(row.data) &&
      onlyKeys(row.native, ['dataDigest', 'createTime', 'updateTime']) &&
      row.native.dataDigest === proofDigest(row.data) &&
      validStamp(row.native.createTime) &&
      validStamp(row.native.updateTime),
    'NATIVE_DOCUMENT_REQUIRED'
  );
}

export const ownedMirrorPaths = () => incident.listIds.map((id) => `lists/${id}/listItems/${incident.sermonId}`);

/**
 * Produce a finite write plan from freshly read RAM-only documents. The caller MUST supply the
 * pinned runtime's actual extractProviderResources function, not resource lists from a manifest.
 * This function is not sufficient authority to apply: publication/native/protected-source checks,
 * an ordinary owned operation, transaction re-reads and an atomic audit are separate prerequisites.
 */
export function planOwnedMirrorEdges({ marker, groups, extractResources }) {
  requireThat(typeof extractResources === 'function', 'RUNTIME_EXTRACTOR_REQUIRED');
  assertDocument(marker, '_control/temporalProviderUsage');
  requireThat(
    marker.data.schemaVersion === 1 &&
      marker.data.projectId === incident.projectId &&
      marker.data.status === 'ready' &&
      marker.data.epoch === incident.originalEpoch,
    'INDEX_MARKER_CHANGED'
  );
  requireThat(
    Array.isArray(groups) &&
      groups.length === 2 &&
      new Set(groups.map((g) => resourceKey(g.resource ?? {}))).size === 2,
    'EXACT_RESOURCES_REQUIRED'
  );
  const plans = [];
  for (const resource of incident.resources) {
    const group = groups.find((g) => same(g.resource, resource));
    requireThat(group, 'EXACT_RESOURCES_REQUIRED');
    const aggregatePath = `temporalProviderUsage/${resourceKey(resource)}/epochs/${marker.data.epoch}`;
    assertDocument(group.aggregate, aggregatePath);
    const aggregate = group.aggregate.data;
    // Existing ordinary aggregates contain only identity, epoch, state and count. Any lifecycle
    // proof or unknown field is deliberately an investigation stop, even if state says active.
    requireThat(
      onlyKeys(aggregate, ['projectId', 'provider', 'account', 'remoteId', 'epoch', 'state', 'referenceCount']) &&
        Object.entries(resource).every(([field, value]) => aggregate[field] === value) &&
        aggregate.epoch === marker.data.epoch &&
        aggregate.state === 'active' &&
        Number.isSafeInteger(aggregate.referenceCount) &&
        aggregate.referenceCount >= 0,
      'AGGREGATE_NOT_ORDINARY_ACTIVE'
    );
    requireThat(
      group.edges?.allPages === true &&
        Array.isArray(group.edges.rows) &&
        group.edges.rows.length <= 200 &&
        group.edges.rows.length === aggregate.referenceCount,
      'FULL_EDGE_COUNT_REQUIRED'
    );
    requireThat(
      Array.isArray(group.canonicals) &&
        group.canonicals.length <= 203 &&
        new Set(group.canonicals.map((row) => row.path)).size === group.canonicals.length,
      'CANONICAL_SET_INVALID'
    );
    const canonical = new Map(group.canonicals.map((row) => [row.path, row]));
    const existing = new Set();
    const hasResource = (row) => {
      assertDocument(row, row?.path);
      const resources = extractResources(incident.projectId, row.path, row.data);
      requireThat(Array.isArray(resources) && resources.some((r) => same(r, resource)), 'CANONICAL_REFERENCE_CHANGED');
    };
    for (const edge of group.edges.rows) {
      const path = edge?.data?.canonicalPath;
      requireThat(
        typeof path === 'string' &&
          path.length <= 2048 &&
          /^(sermons|lists|series|speakers|images|durableJobIntents|temporalProviderPendingReferences)\//.test(path) &&
          path.split('/').length % 2 === 0 &&
          !path.split('/').some((v) => !v || v === '.' || v === '..') &&
          onlyKeys(edge.data, ['canonicalPath', 'projectId']) &&
          edge.data.projectId === incident.projectId &&
          !existing.has(path),
        'EXISTING_EDGE_INVALID'
      );
      assertDocument(edge, `${aggregatePath}/edges/${key(path)}`);
      hasResource(canonical.get(path));
      existing.add(path);
    }
    const targets = ownedMirrorPaths();
    for (const path of targets) {
      requireThat(!existing.has(path), 'TARGET_EDGE_ALREADY_PRESENT');
      hasResource(canonical.get(path));
    }
    requireThat(same([...canonical.keys()].sort(), [...existing, ...targets].sort()), 'CANONICAL_SET_INVALID');
    plans.push({
      aggregatePath,
      beforeCount: aggregate.referenceCount,
      afterCount: aggregate.referenceCount + 3,
      aggregateNative: group.aggregate.native,
      existingEdges: group.edges.rows.map((row) => ({ path: row.path, native: row.native })),
      canonicals: group.canonicals.map((row) => ({ path: row.path, native: row.native })),
      creates: targets.map((path) => ({
        path: `${aggregatePath}/edges/${key(path)}`,
        data: { canonicalPath: path, projectId: incident.projectId },
      })),
    });
  }
  return {
    schemaVersion: 1,
    incidentDigest: proofDigest(incident),
    markerNative: marker.native,
    aggregates: plans,
    edgeCreates: 6,
    countUpdates: 2,
    providerWrites: 0,
    canonicalWrites: 0,
  };
}

/** Exact safe result only. Real runtime job-store validation remains mandatory when projecting. */
export function capturedEmailProjection({ job, native, acceptedCapture }) {
  requireThat(
    job?.projectId === incident.projectId &&
      job.jobId === incident.emailJobId &&
      job.kind === 'email.deliver' &&
      job.state === 'running' &&
      Number.isSafeInteger(job.revision) &&
      job.revision > 0 &&
      job.generation === incident.emailGeneration &&
      job.workflowId === incident.emailWorkflowId &&
      job.entity?.type === 'mail' &&
      job.entity.id === incident.mailId,
    'EMAIL_JOB_CHANGED'
  );
  requireThat(
    native?.workflowId === incident.emailWorkflowId &&
      native.runId === incident.emailRunId &&
      native.status === 'FAILED' &&
      native.latestRunId === native.runId &&
      native.failureType === 'EMAIL_STALE_JOB' &&
      native.pendingActivities === 0 &&
      native.terminalEventType === 'WORKFLOW_EXECUTION_FAILED' &&
      /^[a-f0-9]{64}$/.test(native.historyDigest ?? ''),
    'EMAIL_NATIVE_FAILURE_REQUIRED'
  );
  requireThat(
    acceptedCapture?.mailId === incident.mailId &&
      acceptedCapture.mailState === 'SUCCESS' &&
      acceptedCapture.receiptAccepted === true &&
      acceptedCapture.captureId === incident.captureId &&
      acceptedCapture.payloadSha256 === incident.payloadSha256 &&
      acceptedCapture.payloadHashMatches === true &&
      acceptedCapture.externalDelivery === false &&
      acceptedCapture.profileId === 'urm-app-staging-mail-capture-v1' &&
      acceptedCapture.profileVersion === 1 &&
      acceptedCapture.projectId === incident.projectId,
    'EMAIL_CAPTURE_CHANGED'
  );
  return {
    expectedRevision: job.revision,
    state: 'succeeded',
    actions: [],
    destinations: [{ destination: 'email', state: 'confirmed' }],
    result: {
      externalDelivery: false,
      deliveryTransport: {
        schemaVersion: 1,
        mode: 'capture',
        projectId: incident.projectId,
        profileId: 'urm-app-staging-mail-capture-v1',
        version: 1,
        captureId: incident.captureId,
        payloadSha256: incident.payloadSha256,
      },
    },
  };
}
