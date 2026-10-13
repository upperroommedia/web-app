jest.mock('./providerReceipts', () => ({
  ...jest.requireActual('./providerReceipts'),
  listProviderAcknowledgementsForJob: jest.fn().mockResolvedValue([]),
}));
jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { firestore: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) }) },
}));
jest.mock('axios', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../subsplashUtils', () => ({
  authenticateSubsplash: jest.fn().mockResolvedValue('private-token'),
  createAxiosConfig: (url: string) => ({ url }),
}));
jest.mock('../../soundcloudSecrets', () => ({
  runWithSoundCloudAccessToken: (run: (token: string) => Promise<unknown>) => run('private-token'),
}));
import axios from 'axios';
import {
  isUploadedSubsplashAudioOutput,
  probeSubsplashAudioOutput,
  verifyPublishingProviderFetchSettled,
} from './providerReadiness';
import { listProviderAcknowledgementsForJob, providerReceiptId } from './providerReceipts';
import type { ProviderReceipt } from './providerReceipts';
const output = {
  uploaded_at: '2026-01-01',
  file_size: 4000,
  duration: 1000,
  content_type: 'audio/mp3',
  _links: { download: { href: 'https://core.subsplash.com/audio' } },
};
describe('provider readiness and immutable source retention proof', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
    jest.clearAllMocks();
  });
  it('rejects allocated but unuploaded audio', () => {
    expect(isUploadedSubsplashAudioOutput({ ...output, uploaded_at: undefined })).toBe(false);
    expect(isUploadedSubsplashAudioOutput({ ...output, duration: 0 })).toBe(false);
  });
  it('probes a bounded GET and never forwards provider auth through a CDN redirect', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cdn.invalid/audio.mp3' } })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'content-type': 'audio/mp3' } })
      );
    global.fetch = fetch;
    expect(await probeSubsplashAudioOutput(output, 'private-token')).toBe(true);
    expect(fetch.mock.calls[0][1].headers).toEqual({ Range: 'bytes=0-1023', Authorization: 'Bearer private-token' });
    expect(fetch.mock.calls[1][1].headers).toEqual({ Range: 'bytes=0-1023' });
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
  });
  it('rejects empty outputs and insecure redirects', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://cdn.invalid/audio' } }));
    expect(await probeSubsplashAudioOutput(output, 'private-token')).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('requires original same-resource ACK claim proof plus terminal GET before releasing an adopted transcode source', async () => {
    const receipt: ProviderReceipt = {
      projectId: 'project',
      jobId: 'job',
      operationKey: 'durable:project:job:create',
      step: 'subsplash-transcode',
      fingerprint: 'a'.repeat(64),
      owner: 'attempt',
      revision: 3,
      state: 'confirmed',
      result: { id: 'transcode' },
      updatedAtMillis: 0,
      adoptionAudit: {
        decision: 'adopt_existing_resource',
        duplicateRiskAcknowledged: true,
        evidenceReference: 'verified record',
        reason: 'explicit adoption',
      },
    };
    const fact = {
      schemaVersion: 1,
      receiptId: providerReceiptId(receipt.operationKey, receipt.step),
      projectId: 'project',
      jobId: 'job',
      step: receipt.step,
      attemptOwner: 'attempt',
      claimRevision: 1,
      payloadFingerprint: receipt.fingerprint,
      remoteId: 'transcode',
      disposition: 'same_resource',
      acknowledgedAtMillis: 1,
    };
    (listProviderAcknowledgementsForJob as jest.Mock).mockResolvedValue([]);
    expect(
      await verifyPublishingProviderFetchSettled({ projectId: 'project', jobId: 'job' }, [
        { receiptId: fact.receiptId, receipt },
      ])
    ).toBe(false);
    (listProviderAcknowledgementsForJob as jest.Mock).mockResolvedValue([
      { acknowledgementId: 'b'.repeat(64), acknowledgement: { ...fact, payloadFingerprint: 'different' } },
    ]);
    expect(
      await verifyPublishingProviderFetchSettled({ projectId: 'project', jobId: 'job' }, [
        { receiptId: fact.receiptId, receipt },
      ])
    ).toBe(false);
    (listProviderAcknowledgementsForJob as jest.Mock).mockResolvedValue([
      { acknowledgementId: 'b'.repeat(64), acknowledgement: fact },
    ]);
    (axios as unknown as jest.Mock).mockResolvedValue({ data: { id: 'transcode', status: 'processing' } });
    expect(
      await verifyPublishingProviderFetchSettled({ projectId: 'project', jobId: 'job' }, [
        { receiptId: fact.receiptId, receipt },
      ])
    ).toBe(false);
    (axios as unknown as jest.Mock).mockResolvedValue({ data: { id: 'transcode', status: 'complete' } });
    expect(
      await verifyPublishingProviderFetchSettled({ projectId: 'project', jobId: 'job' }, [
        { receiptId: fact.receiptId, receipt },
      ])
    ).toBe(true);
    (listProviderAcknowledgementsForJob as jest.Mock).mockResolvedValue([
      {
        acknowledgementId: 'b'.repeat(64),
        acknowledgement: { ...fact, disposition: 'orphaned', remoteId: 'original-different' },
      },
    ]);
    expect(
      await verifyPublishingProviderFetchSettled({ projectId: 'project', jobId: 'job' }, [
        { receiptId: fact.receiptId, receipt },
      ])
    ).toBe(false);
  });
  it('retains source leases until all confirmed transcode jobs are terminal', async () => {
    const receipt: ProviderReceipt = {
      projectId: 'project',
      jobId: 'job',
      operationKey: 'durable:project:job:create',
      step: 'subsplash-transcode',
      fingerprint: 'hash',
      state: 'confirmed',
      result: { id: 'transcode' },
      updatedAtMillis: 0,
    };
    (axios as unknown as jest.Mock).mockResolvedValue({ data: { id: 'transcode', status: 'processing' } });
    expect(
      await verifyPublishingProviderFetchSettled({ projectId: 'project', jobId: 'job' }, [{ receiptId: 'id', receipt }])
    ).toBe(false);
    (axios as unknown as jest.Mock).mockResolvedValue({ data: { id: 'transcode', status: 'complete' } });
    expect(
      await verifyPublishingProviderFetchSettled({ projectId: 'project', jobId: 'job' }, [{ receiptId: 'id', receipt }])
    ).toBe(true);
    expect(
      await verifyPublishingProviderFetchSettled({ projectId: 'project', jobId: 'other' }, [
        { receiptId: 'id', receipt },
      ])
    ).toBe(false);
    expect(
      await verifyPublishingProviderFetchSettled({ projectId: 'project', jobId: 'job' }, [
        { receiptId: 'id', receipt: { ...receipt, state: 'needs_review' } },
      ])
    ).toBe(false);
  });
});
