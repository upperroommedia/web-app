import { createReviewedCreateActivities } from './reviewed-create';
import {
  savePublishingCreateReviewCheckpoint,
  loadPublishingCreateReviewContinuation,
} from '../../../../functions/src/temporal/publishing/reviewedCreateContinuation';
jest.mock('../../../../functions/src/temporal/publishing/reviewedCreateContinuation', () => ({
  PUBLISHING_CREATE_REVIEW_CHECKPOINTS: 'temporalPublishingCreateReviewCheckpoints',
  savePublishingCreateReviewCheckpoint: jest.fn(),
  loadPublishingCreateReviewContinuation: jest.fn(),
}));
const ref = { projectId: 'test', jobId: 'job' };
function setup() {
  const tx = { set: jest.fn(), get: jest.fn() };
  const db: any = { runTransaction: jest.fn(async (fn: any) => fn(tx)) };
  const store: any = { assertCurrentInTransaction: jest.fn(), assertCurrent: jest.fn() };
  const activities = createReviewedCreateActivities(db, store, 'test');
  return { tx, db, store, activities };
}
beforeEach(() => jest.clearAllMocks());
test('private checkpoint capture is fenced before writes without granting canonical mutation authority', async () => {
  const { tx, db, store, activities } = setup();
  (savePublishingCreateReviewCheckpoint as jest.Mock).mockImplementationOnce(async (current, _input, deps) => {
    await deps.commitCurrent(current, async (transaction: any) => {
      expect(store.assertCurrentInTransaction).toHaveBeenCalledWith(tx, ref);
      transaction.set(
        { firestore: db, path: 'temporalPublishingCreateReviewCheckpoints/' + 'a'.repeat(64) },
        { checkpoint: true }
      );
    });
    return { checkpointId: 'a'.repeat(64) };
  });
  await expect(
    activities.savePublishingCreateReviewCheckpoint(ref, {
      workflow: 'publishing',
      waitingStep: 'subsplash-media',
      completedStages: [],
    })
  ).resolves.toEqual({ checkpointId: 'a'.repeat(64) });
  expect(tx.set).toHaveBeenCalledTimes(1);
  expect(store.assertCurrent).not.toHaveBeenCalled();
});
test.each([
  'sermons/sermon',
  'temporalPublishingCreateReviewCheckpoints/untrusted',
  'temporalPublishingCreateReviewCheckpoints/' + 'a'.repeat(64) + '/nested/doc',
])('checkpoint writer cannot change %s', async (path) => {
  const { tx, db, activities } = setup();
  (savePublishingCreateReviewCheckpoint as jest.Mock).mockImplementationOnce(async (current, _input, deps) =>
    deps.commitCurrent(current, async (transaction: any) => transaction.set({ firestore: db, path }, {}))
  );
  await expect(
    activities.savePublishingCreateReviewCheckpoint(ref, {
      workflow: 'publishing',
      waitingStep: 'subsplash-media',
      completedStages: [],
    })
  ).rejects.toMatchObject({ code: 'PERMISSION_CHANGED' });
  expect(tx.set).not.toHaveBeenCalled();
});
test('source continuation loader must recheck the original actor before returning a remaining plan', async () => {
  const { store, activities } = setup();
  store.assertCurrent.mockRejectedValueOnce(Object.assign(new Error('revoked'), { code: 'PERMISSION_CHANGED' }));
  (loadPublishingCreateReviewContinuation as jest.Mock).mockImplementationOnce(async (current, _id, deps) => {
    await deps.assertCurrent(current, {});
    return { plan: {} };
  });
  await expect(activities.loadPublishingCreateReviewContinuation(ref, 'a'.repeat(64))).rejects.toMatchObject({
    code: 'PERMISSION_CHANGED',
  });
  expect(store.assertCurrent).toHaveBeenCalledWith(ref);
});
test('cross-project requests cannot enter either source checkpoint path', async () => {
  const { activities } = setup();
  const foreign = { ...ref, projectId: 'other' };
  await expect(activities.loadPublishingCreateReviewContinuation(foreign, 'a'.repeat(64))).rejects.toMatchObject({
    code: 'PROJECT_MISMATCH',
  });
  await expect(
    activities.savePublishingCreateReviewCheckpoint(foreign, {
      workflow: 'publishing',
      waitingStep: 'subsplash-media',
      completedStages: [],
    })
  ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
  expect(loadPublishingCreateReviewContinuation).not.toHaveBeenCalled();
  expect(savePublishingCreateReviewCheckpoint).not.toHaveBeenCalled();
});
