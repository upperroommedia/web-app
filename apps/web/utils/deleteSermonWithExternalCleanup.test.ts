import { deleteSermonWithExternalCleanup } from './deleteSermonWithExternalCleanup';
const submit = jest.fn();
jest.mock('./durableJobs', () => ({ submitDurableIntent: (...args: unknown[]) => submit(...args) }));
describe('server-owned sermon deletion', () => {
  beforeEach(() => submit.mockReset());
  it('admits only a canonical sermon reference and leaves provider cleanup to the server', async () => {
    submit.mockResolvedValue({ jobId: 'cleanup', admissionState: 'queued' });
    await expect(
      deleteSermonWithExternalCleanup({
        sermonId: 's1',
        subsplashId: 'untrusted',
        soundCloudTrackId: 'untrusted',
        seriesId: 'untrusted',
      })
    ).resolves.toMatchObject({ jobId: 'cleanup' });
    expect(submit).toHaveBeenCalledWith({ kind: 'sermon.delete', entity: { type: 'sermon', id: 's1' }, payload: {} });
  });
  it('keeps the sermon when admission is uncertain', async () => {
    submit.mockRejectedValue(new Error('Outcome unknown'));
    await expect(deleteSermonWithExternalCleanup({ sermonId: 's1' })).rejects.toThrow('Outcome unknown');
  });
  it('rejects a missing canonical identity before submission', async () => {
    await expect(deleteSermonWithExternalCleanup({ sermonId: '' })).rejects.toThrow('Missing sermon id');
    expect(submit).not.toHaveBeenCalled();
  });
});
