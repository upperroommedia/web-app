/** Read-only private email joins. Private documents remain in RAM; only native proofs/safe facts leave. */
import { createHash } from 'node:crypto';
import { nativeSnapshotProof, proofDigest } from './temporal-release-runtime.mjs';
import { OWNED_SMOKE_INCIDENT as incident } from './temporal-owned-smoke-plan.mjs';
import { planOwnedEmailProjection } from './temporal-owned-smoke-email-stage.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) => proofDigest(a) === proofDigest(b);
const keysExactly = (value, keys) =>
  value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort());
const need = (condition, code) => {
  if (!condition) throw Object.assign(new Error(`OWNED_SMOKE_${code}`), { code: `OWNED_SMOKE_${code}` });
};
const profile = Object.freeze({
  schemaVersion: 1,
  mode: 'capture',
  projectId: 'urm-app-staging',
  profileId: 'urm-app-staging-mail-capture-v1',
  version: 1,
});
// Match the capture producer's canonical JSON, including its rejection of undefined/non-JSON input.
const captureCanonical = (value) => {
  if (Array.isArray(value)) return '[' + value.map(captureCanonical).join(',') + ']';
  if (value && typeof value === 'object') {
    need(Object.getPrototypeOf(value) === Object.prototype, 'EMAIL_PRIVATE_OPTIONS_NOT_JSON');
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + captureCanonical(value[k]))
        .join(',') +
      '}'
    );
  }
  need(value === null || ['string', 'boolean', 'number'].includes(typeof value), 'EMAIL_PRIVATE_OPTIONS_NOT_JSON');
  need(typeof value !== 'number' || Number.isFinite(value), 'EMAIL_PRIVATE_OPTIONS_NOT_JSON');
  return JSON.stringify(value);
};

/**
 * Pure verification primitive, not apply authority. The executable reader below always binds the
 * committed incident, never a caller-supplied replacement case. Tests use a synthetic binding so
 * they need no preimage of the real private payload hash or real mail contents.
 */
export function verifyCapturedEmailDocuments({ binding, documents, runtime }) {
  need(
    binding?.projectId === profile.projectId &&
      [
        runtime?.emailMessageId,
        runtime?.secureMailOptions,
        runtime?.extractProviderResources,
        runtime?.durableEntityKey,
      ].every((fn) => typeof fn === 'function'),
    'EMAIL_PINNED_RUNTIME_REQUIRED'
  );
  const { job, intent, entity, critical, mail, receipt, capture } = documents;
  const path = 'mail/' + binding.mailId;
  const messageId = runtime.emailMessageId(binding.projectId, binding.emailJobId);
  need(
    typeof messageId === 'string' &&
      /^<[a-f0-9]{64}@durable\.upperroommedia\.org>$/.test(messageId) &&
      sha(messageId) === binding.captureId,
    'EMAIL_MESSAGE_ID_CHANGED'
  );
  need(
    job?.projectId === binding.projectId &&
      job.jobId === binding.emailJobId &&
      job.kind === 'email.deliver' &&
      job.state === 'running' &&
      job.generation === binding.emailGeneration &&
      job.workflowId === binding.emailWorkflowId &&
      job.entity?.type === 'mail' &&
      job.entity.id === path &&
      !critical,
    'EMAIL_CURRENT_JOB_REQUIRED'
  );
  need(
    intent?.schemaVersion === 1 &&
      intent.projectId === binding.projectId &&
      intent.jobId === binding.emailJobId &&
      intent.kind === job.kind &&
      intent.generation === job.generation &&
      same(intent.entity, job.entity) &&
      intent.actorUid === 'system:email' &&
      intent.payload?.mailPath === path &&
      runtime.extractProviderResources(binding.projectId, 'durableJobIntents/' + binding.emailJobId, intent).length ===
        0,
    'EMAIL_ORIGINAL_INTENT_REQUIRED'
  );
  need(
    entity?.schemaVersion === 1 &&
      entity.projectId === binding.projectId &&
      entity.scope === 'email' &&
      entity.generation === job.generation &&
      entity.activeJobId === job.jobId &&
      same(entity.entity, job.entity),
    'EMAIL_CURRENT_ENTITY_REQUIRED'
  );
  const { delivery, ...mailPayload } = mail ?? {};
  need(
    mail?.meta?.source === 'runtime-alert' &&
      mail.meta.metadata?.mediaItemId === binding.mediaId &&
      same(mailPayload, intent.payload.payload),
    'EMAIL_MAIL_INTENT_PROVENANCE_CHANGED'
  );
  need(
    delivery?.state === 'SUCCESS' &&
      delivery.jobId === job.jobId &&
      delivery.orchestrator === 'temporal' &&
      delivery.messageId === messageId &&
      receipt?.state === 'accepted' &&
      receipt.messageId === messageId &&
      same(receipt.deliveryProfile, profile),
    'EMAIL_ACCEPTED_RECEIPT_REQUIRED'
  );
  const transport = { ...profile, captureId: binding.captureId, payloadSha256: binding.payloadSha256 };
  need(
    capture?.schemaVersion === 1 &&
      capture.messageId === messageId &&
      capture.externalDelivery === false &&
      capture.payloadSha256 === binding.payloadSha256 &&
      same(capture.deliveryProfile, profile) &&
      capture.capturedAt &&
      typeof capture.capturedAt.toMillis === 'function' &&
      Number.isFinite(capture.capturedAt.toMillis()) &&
      capture.capturedAt.toMillis() === Date.parse(binding.capturedAtIso),
    'EMAIL_PRIVATE_CAPTURE_CHANGED'
  );
  need(
    same(capture.options, receipt.options) &&
      capture.options?.messageId === messageId &&
      same(runtime.secureMailOptions(capture.options, messageId), capture.options) &&
      sha(captureCanonical(capture.options)) === binding.payloadSha256,
    'EMAIL_PRIVATE_PAYLOAD_CHANGED'
  );
  // The owned runtime alert producer emits exactly {to,message,meta}. Restrict recovery to
  // its direct envelope, with no template, UID resolution, attachment or mutable configuration.
  // Frozen default sender/reply-to values come only from the original accepted receipt.
  need(
    keysExactly(mailPayload, ['to', 'message', 'meta']) &&
      keysExactly(mailPayload.message, ['subject', 'text', 'html']) &&
      ['subject', 'text', 'html'].every((key) => typeof mailPayload.message[key] === 'string') &&
      Array.isArray(mailPayload.to) &&
      mailPayload.to.length > 0 &&
      mailPayload.to.every((value) => typeof value === 'string' && value.trim()),
    'EMAIL_DIRECT_ALERT_REQUIRED'
  );
  const directOptions = JSON.parse(
    JSON.stringify(
      runtime.secureMailOptions(
        {
          from: receipt.options.from,
          replyTo: receipt.options.replyTo,
          to: mailPayload.to,
          cc: [],
          bcc: [],
          messageId,
          subject: mailPayload.message.subject,
          text: mailPayload.message.text,
          html: mailPayload.message.html,
        },
        messageId
      )
    )
  );
  need(same(directOptions, capture.options), 'EMAIL_REQUEST_CAPTURE_MISMATCH');
  const recipients = [capture.options.to, capture.options.cc, capture.options.bcc].flatMap((v) =>
    v === undefined ? [] : typeof v === 'string' ? [v] : Array.isArray(v) ? v : [v]
  );
  need(
    recipients.length > 0 &&
      recipients.every((v) => typeof v === 'string' && v.trim()) &&
      same(receipt.info, delivery.info) &&
      receipt.info?.messageId === messageId &&
      same(receipt.info.accepted, [...new Set(recipients)]) &&
      same(receipt.info.rejected, []) &&
      same(receipt.info.pending, []) &&
      same(receipt.info.deliveryTransport, transport) &&
      same(delivery.deliveryTransport, transport),
    'EMAIL_ACCEPTANCE_PROVENANCE_CHANGED'
  );
  return {
    mailId: binding.mailId,
    mailState: 'SUCCESS',
    receiptAccepted: true,
    captureId: binding.captureId,
    payloadSha256: binding.payloadSha256,
    payloadHashMatches: true,
    externalDelivery: false,
    profileId: profile.profileId,
    profileVersion: profile.version,
    projectId: binding.projectId,
  };
}

/** Exact fixed incident only. No SDK initialization, credentials, mail prepare/send, or provider calls. */
export async function collectOwnedEmailEvidence({ db, tx, runtime, native }) {
  const read = (ref) => (tx ? tx.get(ref) : ref.get());
  const jobPath = 'durableJobs/' + incident.emailJobId;
  const paths = {
    job: jobPath,
    intent: 'durableJobIntents/' + incident.emailJobId,
    entity:
      'durableJobEntities/' +
      runtime.durableEntityKey(incident.projectId, { type: 'mail', id: 'mail/' + incident.mailId }, 'email.deliver'),
    critical: 'durableJobCriticalSections/' + incident.emailJobId,
    mail: 'mail/' + incident.mailId,
    receipt: 'durableEmailReceipts/' + incident.emailJobId,
    capture: '_mailSandboxCaptures/' + incident.captureId,
  };
  const snapshots = {};
  for (const [name, path] of Object.entries(paths)) {
    snapshots[name] = await read(db.doc(path));
    need(name === 'critical' || snapshots[name].exists, 'EMAIL_PROVENANCE_DOCUMENT_MISSING');
  }
  const documents = Object.fromEntries(Object.entries(snapshots).map(([name, snapshot]) => [name, snapshot.data()]));
  const acceptedCapture = verifyCapturedEmailDocuments({
    binding: {
      ...incident,
      mediaId: incident.resources.find((r) => r.provider === 'subsplash').remoteId,
    },
    documents,
    runtime,
  });
  const emailPlan = planOwnedEmailProjection({
    job: { path: jobPath, data: documents.job, native: nativeSnapshotProof(snapshots.job) },
    native,
    acceptedCapture,
  });
  const protectedDocuments = Object.entries(snapshots)
    .filter(([name]) => name !== 'job')
    .map(([name, snapshot]) =>
      snapshot.exists
        ? { path: paths[name], native: nativeSnapshotProof(snapshot) }
        : { path: paths[name], exists: false }
    );
  return { emailPlan, protectedDocuments };
}
