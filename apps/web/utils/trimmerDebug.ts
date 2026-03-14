type TrimmerDebugPayload = Record<string, unknown>;

interface TrimmerDebugEvent {
  ts: string;
  event: string;
  payload: TrimmerDebugPayload;
}

type TrimmerDebugWindow = Window & {
  __TRIMMER_DEBUG__?: boolean;
  __TRIMMER_DEBUG_BUFFER__?: TrimmerDebugEvent[];
};

function isServerLoggingEnabled(): boolean {
  if (typeof window === 'undefined') {
    return process.env.TRIMMER_DEBUG_API === '1';
  }

  const isDev = process.env.NODE_ENV !== 'production';
  return process.env.NEXT_PUBLIC_TRIMMER_DEBUG_API === '1' || isDev;
}

function isDebugEnabled(): boolean {
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_TRIMMER_DEBUG === '1';
  }

  if (process.env.NEXT_PUBLIC_TRIMMER_DEBUG === '1') return true;
  const debugWindow = window as TrimmerDebugWindow;
  if (debugWindow.__TRIMMER_DEBUG__ === true) return true;
  try {
    return window.localStorage.getItem('trimmerDebug') === '1';
  } catch {
    return false;
  }
}

function playerSnapshot(): Record<string, unknown> {
  if (typeof document === 'undefined') return {};
  const player = document.querySelector('.media-player');
  if (!player) return { hasPlayer: false };

  return {
    hasPlayer: true,
    bufferingAttr: player.hasAttribute('data-buffering'),
    pausedAttr: player.hasAttribute('data-paused'),
    canLoadAttr: player.hasAttribute('data-can-load'),
    viewType: player.getAttribute('data-view-type'),
    mediaType: player.getAttribute('data-media-type'),
  };
}

export function logTrimmerDebug(event: string, payload: TrimmerDebugPayload = {}): void {
  if (!isDebugEnabled()) return;

  const entry: TrimmerDebugEvent = {
    ts: new Date().toISOString(),
    event,
    payload: {
      ...payload,
      ...playerSnapshot(),
    },
  };

  console.warn('[TRIMMER_DEBUG]', entry);

  if (typeof window !== 'undefined') {
    try {
      const debugWindow = window as TrimmerDebugWindow;
      if (!Array.isArray(debugWindow.__TRIMMER_DEBUG_BUFFER__)) debugWindow.__TRIMMER_DEBUG_BUFFER__ = [];
      debugWindow.__TRIMMER_DEBUG_BUFFER__.push(entry);
      if (debugWindow.__TRIMMER_DEBUG_BUFFER__.length > 500) {
        debugWindow.__TRIMMER_DEBUG_BUFFER__.splice(0, debugWindow.__TRIMMER_DEBUG_BUFFER__.length - 500);
      }
    } catch {
      // ignore buffer failures
    }
  }

  if (isServerLoggingEnabled()) {
    void fetch('/api/debug/trimmer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => {
      // best-effort logging
    });
  }
}
