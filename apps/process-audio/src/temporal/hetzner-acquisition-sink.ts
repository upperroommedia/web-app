import { randomUUID } from 'node:crypto';
import {
  YouTubeStreamBoundaryError,
  YouTubeStreamProviderError,
  type YouTubeAcquisitionStreamSink,
} from '../processYouTubeUrl';
import type { MediaJobRef } from './types';
import type { createYouTubeAcquisitionHostStore } from './hetzner-acquisition-store';
import { startNativeYouTubeProducer, type NativeYouTubeProducer } from './hetzner-acquisition-producer';
import { uploadYouTubeObject, YouTubeUploadProducerFailed } from './hetzner-acquisition-upload';

/** Connects the existing complete authentication ladder to real native producer
 * bytes and owner-fenced Storage uploads. The isolated host bootstrap MUST have
 * claimed native ownership and reserved shared resources before running that
 * ladder; this sink rechecks actual canonical eligibility before each attempt.
 * No URL, cookie, diagnostics or arbitrary command is accepted over HTTP here.
 */
export function createNativeYouTubeAcquisitionSink(options: {
  ref: MediaJobRef;
  store: ReturnType<typeof createYouTubeAcquisitionHostStore>;
}): YouTubeAcquisitionStreamSink {
  const ref = Object.freeze({ ...options.ref });
  return {
    async execute(input) {
      if (input.cancellation.isCancellationRequested) throw new YouTubeStreamBoundaryError();
      await options.store.assertCurrent(ref);
      if (input.cancellation.isCancellationRequested) throw new YouTubeStreamBoundaryError();
      const journal = options.store.upload(ref, randomUUID());
      let producer: NativeYouTubeProducer | undefined;
      try {
        return await uploadYouTubeObject({
          journal,
          signal: input.cancellation.signal,
          start: async () => {
            input.cancellation.signal.throwIfAborted();
            producer = await startNativeYouTubeProducer(input);
            return producer;
          },
        });
      } catch (error) {
        if (error instanceof YouTubeUploadProducerFailed && !input.cancellation.isCancellationRequested) {
          const message = producer?.diagnostic();
          if (message) throw new YouTubeStreamProviderError(message);
        }
        // Unknown transport, malformed metadata, resources, cancellation, and
        // unconfirmed native drain never become authentication/format retries.
        throw new YouTubeStreamBoundaryError();
      }
    },
  };
}
