import editSermon, { editableSermonIntent } from '../../utils/editSermon';
import { createEmptySermon } from '../../types/Sermon';
import { emptyList } from '../../types/List';
import { uploadStatus } from '../../types/SermonTypes';
const submit = jest.fn();
jest.mock('../../utils/durableJobs', () => ({ submitDurableIntent: (...args: unknown[]) => submit(...args) }));
jest.mock('../../firebase/firestore', () => ({ Timestamp: {}, default: {} }));

describe('durable sermon editing', () => {
  beforeEach(() => {
    submit.mockReset();
    submit.mockResolvedValue({ jobId: 'edit-job', admissionState: 'queued' });
  });
  it('keeps provider identities, status, counters and timestamps out of editable patch', () => {
    const sermon = { ...createEmptySermon(), id: 's1', subsplashId: 'remote', numberOfLists: 9 };
    const patch = editableSermonIntent(sermon);
    expect(patch).not.toHaveProperty('subsplashId');
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('numberOfLists');
    expect(patch).not.toHaveProperty('editedAtMillis');
    expect(patch).toMatchObject({ title: sermon.title, seriesId: null, youtubeUrl: null });
  });
  it('admits metadata and dependent processing together without waiting for provider mutations', async () => {
    const original = createEmptySermon();
    original.status.soundCloud = uploadStatus.UPLOADED;
    const updated = { ...original, id: 's1', title: 'Changed', seriesId: 'series1' };
    await expect(
      editSermon(updated, [{ ...emptyList, id: 'list1' }], {
        originalSermon: original,
        processAudio: { startTime: 10, duration: 30 },
      })
    ).resolves.toMatchObject({ jobId: 'edit-job' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'sermon.update',
        entity: { type: 'sermon', id: 's1' },
        payload: expect.objectContaining({
          destinations: { listIds: ['list1'], seriesId: 'series1', soundcloud: true },
          processAudio: { startTime: 10, duration: 30 },
        }),
      })
    );
  });
  it('propagates uncertain admission and does not perform compensating browser writes', async () => {
    submit.mockRejectedValue(new Error('Request may already be running'));
    await expect(editSermon(createEmptySermon(), [])).rejects.toThrow('Request may already be running');
  });
});
