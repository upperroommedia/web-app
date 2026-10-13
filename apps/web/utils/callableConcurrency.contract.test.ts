import fs from 'fs';
import path from 'path';
const readFile = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('durable browser mutation boundary', () => {
  it('publishing panels submit intents and never author provider outcomes', () => {
    const panel = readFile('components/SermonPublishPanel.tsx');
    expect(panel).toContain('submitDurableIntent(');
    expect(panel).toContain('EntityJobHistory');
    for (const forbidden of [
      'createFunctionV2',
      'updateDoc(',
      'setDoc(',
      'writeBatch(',
      'publishActivity:',
      'runSubsplashSeriesPublishSaga',
      'runPublishEverywhereFlow',
    ]) {
      expect(panel).not.toContain(forbidden);
    }
    expect(panel).toContain('setUncertainIntent(intent)');
    expect(panel).toContain('submitDurableIntent(uncertainIntent)');
    expect(panel).toContain('setAcceptedJobId(receipt.jobId)');
  });
  it('cards observe shared projections without per-card RTDB progress or browser activity', () => {
    const card = readFile('components/SermonListCard.tsx');
    expect(card).toContain('useEntityJobSummary(jobEntity, currentSermon.activeDurableJobs)');
    expect(card).not.toContain('useObject(');
    expect(card).not.toContain('currentSermon.publishActivity');
    expect(card).not.toContain('onBusyStateChange');
  });
  it('commands include the observed revision and admission uncertainty retains the request', () => {
    const client = readFile('utils/durableJobs.ts');
    expect(client).toContain('expectedRevision: job.revision');
    expect(client).toContain('requestId: pending.requestId');
    expect(client).toContain('getDurableJobReceipt');
    expect(client).toContain('new DurableAdmissionUnknownError(pending.requestId)');
  });
});
