import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CRC32C, Storage } from '@google-cloud/storage';
import type { YouTubeStreamReceipt } from '../processYouTubeUrl';
import type { createYouTubeAcquisitionHostStore } from './hetzner-acquisition-store';

/** Verified native failure after actual drain; only this permits provider fallback. */
export class YouTubeUploadProducerFailed extends Error {
  constructor() {
    super('YOUTUBE_UPLOAD_PRODUCER_FAILED');
  }
}

const uncertain = () => new Error('YOUTUBE_UPLOAD_UNCERTAIN');
const bucketName = 'urm-app-staging.firebasestorage.app';
type Journal = ReturnType<ReturnType<typeof createYouTubeAcquisitionHostStore>['upload']>;
/** Native process ownership remains with the host driver. Completion must reflect
 * native exit status; drain must verify ALL producer descendants and pipeline
 * handles, rejecting unknown drain. Neither callback may be supplied by HTTP.
 */
export interface YouTubeUploadProducer {
  output: Readable;
  completion: Promise<'succeeded' | 'failed'>;
  drain(): Promise<void>;
}

/** Concrete bounded Storage transfer; not the native producer/scratch driver.
 * It never retries a write or starts another producer on an ambiguous upload.
 * A previously recorded complete byte stream is reconciled by GET on its SAME
 * object. Partial/unknown objects remain named by the durable private journal.
 */
export async function uploadYouTubeObject(options: {
  journal: Journal;
  signal: AbortSignal;
  start(): Promise<YouTubeUploadProducer>;
}): Promise<YouTubeStreamReceipt> {
  options.signal.throwIfAborted();
  const journal = options.journal;
  const intent = await journal.begin();
  options.signal.throwIfAborted();
  // Dedicated client: no replay of a non-repeatable provider byte stream.
  const storage = new Storage({ projectId: 'urm-app-staging', retryOptions: { autoRetry: false, maxRetries: 0 } });
  const file = storage.bucket(bucketName).file(journal.path);
  let expected = intent.expected;
  if (intent.launch) {
    const producer = await options.start();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([options.signal, cancellation.signal]);
    const hash = new CRC32C();
    let bytes = 0;
    let eof = false;
    const meter = new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.byteLength;
        if (!Number.isSafeInteger(bytes) || bytes > 20 * 1024 ** 3) return done(uncertain());
        hash.update(chunk);
        done(null, chunk);
      },
      flush(done) {
        eof = true;
        done();
      },
    });
    let drained: Promise<void> | undefined;
    let rejectDrain: (reason: unknown) => void = () => undefined;
    const failedDrain = new Promise<never>((_, reject) => {
      rejectDrain = reject;
    });
    void failedDrain.catch(() => undefined);
    const drain = () =>
      (drained ??= Promise.resolve()
        .then(() => producer.drain())
        .catch((error) => {
          cancellation.abort();
          rejectDrain(error);
          throw error;
        }));
    // Pipeline removes its abort listener after upload completion. Keep native
    // cancellation alive until the producer itself has exited and drained.
    const onAbort = () => {
      void drain().catch(() => undefined);
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    try {
      const completion = producer.completion.then(
        // A known failed producer already closed and drained its native pipes.
        // Let its bounded partial upload settle naturally. Only a successful
        // transfer plus known failed native exit can permit provider fallback;
        // promise ordering cannot establish what caused a transfer failure.
        (result) => result,
        () => {
          cancellation.abort();
          throw uncertain();
        }
      );
      // Observe both promises immediately, including rejection while stream setup
      // or authentication is still pending. Failed transfers force native drain.
      let transfer: Promise<void>;
      // Attach a rejection handler before any SDK setup can throw synchronously.
      void completion.catch(() => undefined);
      try {
        transfer = pipeline(
          producer.output,
          meter,
          file.createWriteStream({
            resumable: true,
            chunkSize: 1024 * 1024,
            validation: 'crc32c',
            preconditionOpts: { ifGenerationMatch: 0 },
            metadata: { contentType: 'application/octet-stream', metadata: journal.binding },
          }),
          { signal }
        ).catch(async () => {
          await drain();
          throw uncertain();
        });
      } catch {
        cancellation.abort();
        await drain();
        await completion.catch(() => undefined);
        throw uncertain();
      }
      const results = await Promise.race([Promise.allSettled([transfer, completion]), failedDrain]);
      await drain();
      options.signal.throwIfAborted();
      if (results[0].status === 'fulfilled' && results[1].status === 'fulfilled' && results[1].value === 'failed') {
        await journal.rejectFailedProducer(async () => {
          await drain();
        });
        throw new YouTubeUploadProducerFailed();
      }
      if (results[1].status !== 'fulfilled' || results[1].value !== 'succeeded' || !eof || bytes <= 0)
        throw uncertain();
      // Even a lost final upload ACK can be reconciled once the complete source
      // checksum and successful native exit+drain are known and durably recorded.
      expected = { bytes, crc32c: hash.toString() };
      await journal.recordBytes(expected);
    } finally {
      options.signal.removeEventListener('abort', onAbort);
    }
  }
  if (!expected) throw uncertain(); // Existing incomplete attempt never relaunches.
  options.signal.throwIfAborted();
  const [metadata] = await file.getMetadata();
  if (
    metadata.bucket !== bucketName ||
    metadata.name !== journal.path ||
    typeof metadata.generation !== 'string' ||
    !/^[1-9][0-9]{0,29}$/.test(metadata.generation) ||
    String(metadata.size) !== String(expected.bytes) ||
    metadata.crc32c !== expected.crc32c ||
    Object.entries(journal.binding).some(([key, value]) => metadata.metadata?.[key] !== value)
  )
    throw uncertain();
  const receipt = { path: journal.path, generation: metadata.generation, ...expected };
  options.signal.throwIfAborted();
  await journal.retain(receipt);
  options.signal.throwIfAborted();
  return receipt;
}
