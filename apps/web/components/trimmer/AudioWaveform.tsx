import { useEffect, useRef, useState, memo, useMemo } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { colors } from '../../styles/theme';
import { waveformPreviewService } from './waveformPreview';
import type { WaveformPreview } from './waveformPcm';

interface AudioWaveformProps {
  /** URL of the audio file */
  url: string;
  /** Original local file/blob, if the URL is a browser object URL. */
  audioBlob?: Blob;
  /** Actual duration from the playable media element, never caller file labels. */
  duration?: number;
  /** Height of the waveform in pixels */
  height?: number;
  /** Color of the waveform bars */
  color?: string;
}

/**
 * Optional bounded PCM peaks rendered on Canvas; playback does not depend on them.
 */
function AudioWaveform({ audioBlob, duration, height = 80, color }: AudioWaveformProps) {
  const theme = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ source: Blob; duration: number; result: WaveformPreview }>();
  const peaks =
    preview && preview.source === audioBlob && preview.duration === duration && preview.result.status === 'ready'
      ? preview.result.peaks
      : undefined;

  // Use theme accent color if not provided
  const waveformColor = useMemo(
    () => color || (theme.palette.mode === 'dark' ? colors.accent.light : colors.accent.primary),
    [color, theme.palette.mode]
  );

  // Optional local PCM preview only. Compressed/remote recordings remain fully
  // playable and trimmable without downloading or decoding their entire content.
  useEffect(() => {
    if (!audioBlob || !duration || !Number.isFinite(duration)) return;
    let current = true;
    const stop = waveformPreviewService.observe(
      audioBlob,
      duration,
      () => new Worker(new URL('./waveform.worker.ts', import.meta.url)),
      (result) => {
        if (current) setPreview({ source: audioBlob, duration, result });
      }
    );
    return () => {
      current = false;
      stop();
    };
  }, [audioBlob, duration]);

  // Resize redraws a fixed 8 KiB peak array; it never reads the source again.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !peaks) return;
    const draw = () => {
      const width = Math.min(4096, Math.max(1, container.clientWidth));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.ceil(width * dpr);
      canvas.height = Math.ceil(height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = waveformColor;
      const bars = Math.max(1, Math.min(peaks.length, Math.floor(width / 3)));
      const barWidth = width / bars;
      for (let bar = 0; bar < bars; bar++) {
        const from = Math.floor((bar * peaks.length) / bars);
        const until = Math.floor(((bar + 1) * peaks.length) / bars);
        let peak = 0;
        for (let i = from; i < until; i++) peak = Math.max(peak, peaks[i]);
        const barHeight = Math.max(1, peak * height * 0.45);
        ctx.fillRect(bar * barWidth, height / 2 - barHeight, Math.max(1, barWidth - 1), barHeight * 2);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [peaks, height, waveformColor]);

  return (
    <Box
      ref={containerRef}
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
      }}
    >
      {peaks ? (
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          style={{ display: 'block', width: '100%', height: '100%', opacity: 0.5 }}
        />
      ) : (
        <Box
          role="img"
          aria-label="Waveform preview unavailable. Audio playback and trimming are still available."
          sx={{
            position: 'absolute',
            inset: 0,
            backgroundImage: 'url(/audio-wave.svg)',
            backgroundSize: 'auto 60%',
            backgroundPosition: 'center',
            backgroundRepeat: 'repeat-x',
            opacity: 0.3,
          }}
        />
      )}
    </Box>
  );
}

export default memo(AudioWaveform);
