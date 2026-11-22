export const stagingYouTubeRenderOrigins = Object.freeze({
  hetzner: 'https://yt-worker-staging.upperroommedia.org',
  moses: 'https://yt-moses-staging.upperroommedia.org',
});

export type YouTubeRenderTarget = keyof typeof stagingYouTubeRenderOrigins;

export interface YouTubeRenderRuntime {
  runtimeId: string;
  commit: string;
}

export function readYouTubeRenderRuntime(value: unknown): YouTubeRenderRuntime | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== 'commit,runtimeId' ||
    !('commit' in value) ||
    typeof value.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    !('runtimeId' in value) ||
    typeof value.runtimeId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.runtimeId)
  )
    throw new Error('Invalid staging YouTube render runtime.');
  return { runtimeId: value.runtimeId, commit: value.commit };
}

/** Only a new native launch needs the receiving process to match the prepared runtime. */
export function assertYouTubeRenderRuntime(
  pin: YouTubeRenderRuntime | undefined,
  runtimeId: string | undefined,
  commit: string
): void {
  if (pin && (pin.runtimeId !== runtimeId || pin.commit !== commit)) throw new Error('YOUTUBE_RENDER_RUNTIME_MISMATCH');
}

/** Old staging records were created before there was a second render host. */
export function readYouTubeRenderTarget(value: unknown): YouTubeRenderTarget {
  if (value === undefined || value === 'hetzner') return 'hetzner';
  if (value === 'moses') return 'moses';
  throw new Error('Invalid staging YouTube render target.');
}

/** The initial target remains intact. A native closed guest handoff can change only the head. */
export function readYouTubeRenderHeadTarget(record: { get: (field: string) => unknown }): YouTubeRenderTarget {
  const initial = readYouTubeRenderTarget(record.get('renderTarget'));
  const head = record.get('renderHeadTarget');
  if (head === undefined) return initial;
  if (initial !== 'moses' || head !== 'hetzner') throw new Error('Invalid staging YouTube render handoff.');
  return head;
}

/** The staging desktop runs public extraction with no browser account state. */
export function isMosesYouTubeRenderHost(): boolean {
  return process.env.PROCESS_AUDIO_TEMPORAL_YOUTUBE_RENDER_TARGET === 'moses';
}
