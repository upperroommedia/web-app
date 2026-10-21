import type { ProcessAudioInputType } from '../types';
import type { LegacyOriginalSource } from '@upperroom/orchestration/legacy-media-execution';
import type { LogContext } from '../context';
export type HostInput = {
  v: 1;
  id: string;
  projectId: 'urm-app' | 'urm-app-staging';
  ctx: LogContext;
} & (
  | { kind: 'canary'; scope: 'guest' | 'authenticated' }
  | {
      kind: 'legacy-full';
      data: ProcessAudioInputType;
      bucketName: string;
      originalSource?: LegacyOriginalSource;
      taskId: string | null;
    }
);
/** Do not serialize SDK handles, request auth, arbitrary body extensions or an
 * executable/binary path. Only the existing authorized parent's fixed inputs. */
export function legacyHostInput(o: {
  id: string;
  projectId: 'urm-app' | 'urm-app-staging';
  ctx: LogContext;
  data: ProcessAudioInputType;
  bucketName: string;
  originalSource?: LegacyOriginalSource;
  taskId: string | null;
}): HostInput {
  const data = Object.fromEntries(
    [
      'id',
      'startTime',
      'duration',
      'deleteOriginal',
      'skipTranscode',
      'introUrl',
      'outroUrl',
      'youtubeUrl',
      'storageFilePath',
    ]
      .filter((key) => o.data[key as keyof ProcessAudioInputType] !== undefined)
      .map((key) => [key, Reflect.get(o.data, key)])
  ) as ProcessAudioInputType;
  return {
    v: 1,
    id: o.id,
    projectId: o.projectId,
    kind: 'legacy-full',
    data,
    bucketName: o.bucketName,
    taskId: o.taskId,
    ...(o.originalSource ? { originalSource: o.originalSource } : {}),
    ctx: hostContext(o.ctx),
  };
}
export function hostContext(ctx: LogContext): LogContext {
  return Object.fromEntries(
    [
      'requestId',
      'sermonId',
      'operation',
      'youtubeSuccessfulAcquisitionAuthority',
      'youtubeBrowserPoTokenAttempted',
      'youtubeCookieRefreshAttempted',
      'youtubeCookieRefreshSucceeded',
    ]
      .filter((key) => ctx[key] !== undefined)
      .map((key) => [key, ctx[key]])
  ) as LogContext;
}
