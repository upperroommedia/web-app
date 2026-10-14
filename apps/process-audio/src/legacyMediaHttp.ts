import type { Bucket } from '@google-cloud/storage';
import {
  withLegacyMediaExecution,
  type LegacyMediaExecutionInput,
  type LegacyOriginalSource,
} from '@upperroom/orchestration/legacy-media-execution';

/** The HTTP processing callback handles its own response. A resolved callback is
 * insufficient evidence of settled effects: observe its actual response and
 * explicit settlement failures before completing the drain-visible lease. */
export function withNativeMediaHttpExecution<T>(
  input: LegacyMediaExecutionInput,
  response: { statusCode: number; locals: { legacySettlementFailed?: boolean } },
  process: (originalSource?: LegacyOriginalSource) => Promise<T>
): Promise<T> {
  return withLegacyMediaExecution(
    {
      ...input,
      operation: 'execute',
      hasUncertainOutcome: () => response.statusCode >= 400 || response.locals.legacySettlementFailed === true,
    },
    process
  );
}

/** Use the SDK's actual generation selector for all original-object reads and
 * potential cleanup. A replacement at the same path must never be processed. */
export function pinOriginalLegacySourceBucket(bucket: Bucket, source?: LegacyOriginalSource): Bucket {
  if (!source || source.kind === 'youtube') return bucket;
  if (
    source.bucket !== bucket.name ||
    !/^[1-9][0-9]{0,30}$/.test(source.generation) ||
    !Number.isSafeInteger(Number(source.generation))
  )
    throw new Error('Original source belongs to another bucket or generation.');
  return new Proxy(bucket, {
    get(target, property) {
      if (property === 'file')
        return (name: string, options?: Parameters<Bucket['file']>[1]) => {
          if (name !== source.path) return target.file(name, options);
          if (options?.generation !== undefined && String(options.generation) !== source.generation)
            throw new Error('Original source generation cannot be changed.');
          return target.file(name, { ...options, generation: source.generation });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
