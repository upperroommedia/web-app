import { useEffect, useRef, useState, memo, useCallback } from 'react';
import Box from '@mui/material/Box';
import { alpha, useTheme } from '@mui/material/styles';
import { colors } from '../../styles/theme';
import { keyframes } from '@mui/system';

interface AudioWaveformProps {
  /** URL of the audio file */
  url: string;
  /** Height of the waveform in pixels */
  height?: number;
  /** Color of the waveform bars */
  color?: string;
  /** Number of bars/peaks to display */
  barCount?: number;
}

/**
 * Audio waveform visualization using Web Audio API and Canvas.
 * Decodes audio and renders a visual waveform representation.
 */
function AudioWaveform({ url, height = 80, color, barCount = 200 }: AudioWaveformProps) {
  const theme = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const peaksComputedForUrl = useRef<string | null>(null);

  // Use theme accent color if not provided
  const waveformColor = color || colors.accent.primary;

  // Compute peaks from audio data
  const computePeaks = useCallback(
    async (audioBuffer: AudioBuffer): Promise<number[]> => {
      const channelData = audioBuffer.getChannelData(0); // Use first channel
      const samplesPerBar = Math.floor(channelData.length / barCount);
      const computedPeaks: number[] = [];

      for (let i = 0; i < barCount; i++) {
        const start = i * samplesPerBar;
        const end = Math.min(start + samplesPerBar, channelData.length);

        // Find max absolute value in this segment
        let max = 0;
        for (let j = start; j < end; j++) {
          const absValue = Math.abs(channelData[j]);
          if (absValue > max) max = absValue;
        }
        computedPeaks.push(max);
      }

      // Normalize peaks to 0-1 range
      const maxPeak = Math.max(...computedPeaks, 0.01);
      return computedPeaks.map((peak) => peak / maxPeak);
    },
    [barCount]
  );

  // Fetch and decode audio
  useEffect(() => {
    // Skip if we've already computed peaks for this URL
    if (peaksComputedForUrl.current === url) {
      return;
    }

    let cancelled = false;

    const loadAudio = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Fetch audio data
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error('Failed to fetch audio');
        }

        const arrayBuffer = await response.arrayBuffer();
        if (cancelled) return;

        // Decode audio
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        if (cancelled) return;

        // Compute peaks
        const computedPeaks = await computePeaks(audioBuffer);
        if (cancelled) return;

        setPeaks(computedPeaks);
        peaksComputedForUrl.current = url;

        // Clean up audio context
        await audioContext.close();
      } catch (err) {
        if (!cancelled) {
          console.error('Error loading audio waveform:', err);
          setError('Failed to load waveform');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    loadAudio();

    return () => {
      cancelled = true;
    };
  }, [url, computePeaks]);

  // Draw waveform on canvas
  useEffect(() => {
    if (!canvasRef.current || peaks.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Get device pixel ratio for sharp rendering
    const dpr = window.devicePixelRatio || 1;

    // Set canvas size accounting for device pixel ratio
    const containerWidth = containerRef.current?.clientWidth || canvas.clientWidth;
    canvas.width = containerWidth * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.clearRect(0, 0, containerWidth, height);

    // Calculate bar dimensions
    const barWidth = containerWidth / peaks.length;
    const barGap = Math.max(1, barWidth * 0.2);
    const actualBarWidth = barWidth - barGap;
    const centerY = height / 2;
    const maxBarHeight = height * 0.45; // Leave some padding

    // Draw mirrored waveform
    ctx.fillStyle = waveformColor;

    peaks.forEach((peak, index) => {
      const x = index * barWidth + barGap / 2;
      const barHeight = Math.max(2, peak * maxBarHeight);

      // Draw top half
      ctx.fillRect(x, centerY - barHeight, actualBarWidth, barHeight);

      // Draw bottom half (mirrored)
      ctx.fillRect(x, centerY, actualBarWidth, barHeight);
    });
  }, [peaks, height, waveformColor]);

  // Handle resize
  useEffect(() => {
    if (!canvasRef.current || peaks.length === 0) return;

    const handleResize = () => {
      // Trigger re-render by updating a dummy state
      // The canvas will be redrawn in the drawing effect
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const containerWidth = containerRef.current?.clientWidth || canvas.clientWidth;
      canvas.width = containerWidth * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${containerWidth}px`;
      canvas.style.height = `${height}px`;
      ctx.scale(dpr, dpr);

      // Redraw
      ctx.clearRect(0, 0, containerWidth, height);

      const barWidth = containerWidth / peaks.length;
      const barGap = Math.max(1, barWidth * 0.2);
      const actualBarWidth = barWidth - barGap;
      const centerY = height / 2;
      const maxBarHeight = height * 0.45;

      ctx.fillStyle = waveformColor;

      peaks.forEach((peak, index) => {
        const x = index * barWidth + barGap / 2;
        const barHeight = Math.max(2, peak * maxBarHeight);
        ctx.fillRect(x, centerY - barHeight, actualBarWidth, barHeight);
        ctx.fillRect(x, centerY, actualBarWidth, barHeight);
      });
    };

    const resizeObserver = new ResizeObserver(handleResize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [peaks, height, waveformColor]);

  if (isLoading) {
    return <WaveformLoadingAnimation color={waveformColor} height={height} />;
  }

  if (error) {
    // Show placeholder pattern on error
    return (
      <Box
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
    );
  }

  return (
    <Box
      ref={containerRef}
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          opacity: 0.5,
        }}
      />
    </Box>
  );
}

// Animated waveform loading placeholder
const waveAnimation = keyframes`
  0%, 100% {
    transform: scaleY(0.3);
  }
  50% {
    transform: scaleY(1);
  }
`;

function WaveformLoadingAnimation({ color, height }: { color: string; height: number }) {
  // Generate more bars to fill the width
  const barCount = 100;
  const bars = Array.from({ length: barCount }, (_, i) => {
    // Create a wave pattern with delays
    const delay = (i % 10) * 0.08; // Repeating wave pattern
    const baseHeight = 0.25 + Math.sin((i / barCount) * Math.PI * 2) * 0.35 + Math.random() * 0.2; // Vary base heights with some randomness
    return { delay, baseHeight };
  });

  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      {bars.map((bar, i) => (
        <Box
          key={i}
          sx={{
            flex: 1,
            mx: '1px',
            height: `${bar.baseHeight * height * 0.7}px`,
            bgcolor: color,
            opacity: 0.35,
            borderRadius: '1px',
            animation: `${waveAnimation} 1.2s ease-in-out infinite`,
            animationDelay: `${bar.delay}s`,
            transformOrigin: 'center',
          }}
        />
      ))}
    </Box>
  );
}

export default memo(AudioWaveform);
