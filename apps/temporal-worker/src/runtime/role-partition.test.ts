import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { createRuntimeActivities } from './activities';
test('real controls factory exposes metadata without provider mutation activities', () => {
  const projectId = firebaseAdmin.app().options.projectId!;
  const { queues } = createRuntimeActivities(projectId, ['urm-controls', 'urm-orchestration']);
  const controls = Object.keys(queues['urm-controls']);
  for (const name of [
    'beginDurableJob',
    'finishDurableJob',
    'readMediaCompletion',
    'requestMediaCancellation',
    'loadPublishingPlan',
    'compilePublishingCriticalRepairEvidence',
    'savePublishingCreateReviewCheckpoint',
    'loadPublishingCreateReviewContinuation',
    'projectPublishingEntityAttention',
    'validateAccountOperation',
    'getEmailReceiptState',
    'exhaustEmailRetries',
    'finishImage',
    'confirmSearchPage',
  ])
    expect(controls).toContain(name);
  for (const name of [
    'acquireMedia',
    'mergeMedia',
    'ensurePublishingMedia',
    'cleanupCancelledPublishing',
    'executeReviewedPublishingEntityCreate',
    'applyAccountClaims',
    'deliverEmail',
    'uploadImageBytes',
    'syncSearchDocument',
  ])
    expect(controls).not.toContain(name);
  const effects = Object.keys(queues['urm-orchestration']);
  expect(effects).toContain('ensurePublishingMedia');
  expect(effects).toContain('cleanupCancelledPublishing');
  expect(effects).toContain('executeReviewedPublishingEntityCreate');
  expect(effects).not.toContain('beginDurableJob');
  expect(effects).not.toContain('loadPublishingPlan');
});
