export type ProcessingProgressStage =
  | 'queued'
  | 'downloading'
  | 'transcoding'
  | 'trimming'
  | 'finalizing'
  | 'completed'
  | 'processing';

export interface ProcessingProgressState {
  percent: number;
  stage: ProcessingProgressStage;
  stageLabel: string;
  updatedAt: string | null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildFallbackProgress(percent: number): ProcessingProgressState {
  return {
    percent: clampPercent(percent),
    stage: 'processing',
    stageLabel: 'Processing',
    updatedAt: null,
  };
}

export function parseProcessingProgress(value: unknown): ProcessingProgressState | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return buildFallbackProgress(value);
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const rawPercent = candidate.percent;
  if (typeof rawPercent !== 'number' || !Number.isFinite(rawPercent)) {
    return null;
  }

  const stage = typeof candidate.stage === 'string' && candidate.stage ? candidate.stage : 'processing';
  const stageLabel = typeof candidate.stageLabel === 'string' && candidate.stageLabel ? candidate.stageLabel : 'Processing';
  const updatedAt = typeof candidate.updatedAt === 'string' && candidate.updatedAt ? candidate.updatedAt : null;

  return {
    percent: clampPercent(rawPercent),
    stage: stage as ProcessingProgressStage,
    stageLabel,
    updatedAt,
  };
}
