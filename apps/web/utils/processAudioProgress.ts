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
  stagePercent: number;
  overallPercent: number | null;
  hasPercent: boolean;
  stage: ProcessingProgressStage;
  stageLabel: string;
  updatedAt: string | null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildFallbackProgress(percent: number): ProcessingProgressState {
  const clampedPercent = clampPercent(percent);
  return {
    percent: clampedPercent,
    stagePercent: clampedPercent,
    overallPercent: null,
    hasPercent: clampedPercent > 0,
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

  const rawStagePercent = candidate.stagePercent;
  const rawOverallPercent = candidate.overallPercent;

  const stage = typeof candidate.stage === 'string' && candidate.stage ? candidate.stage : 'processing';
  const stageLabel = typeof candidate.stageLabel === 'string' && candidate.stageLabel ? candidate.stageLabel : 'Processing';
  const updatedAt = typeof candidate.updatedAt === 'string' && candidate.updatedAt ? candidate.updatedAt : null;
  const stagePercent =
    typeof rawStagePercent === 'number' && Number.isFinite(rawStagePercent) ? clampPercent(rawStagePercent) : clampPercent(rawPercent);
  const overallPercent =
    typeof rawOverallPercent === 'number' && Number.isFinite(rawOverallPercent)
      ? clampPercent(rawOverallPercent)
      : null;
  const hasPercent =
    (typeof rawStagePercent === 'number' && Number.isFinite(rawStagePercent) && clampPercent(rawStagePercent) > 0) ||
    (typeof rawOverallPercent === 'number' && Number.isFinite(rawOverallPercent) && clampPercent(rawOverallPercent) > 0) ||
    (typeof rawPercent === 'number' && Number.isFinite(rawPercent) && clampPercent(rawPercent) > 0);

  return {
    percent: stagePercent,
    stagePercent,
    overallPercent,
    hasPercent,
    stage: stage as ProcessingProgressStage,
    stageLabel,
    updatedAt,
  };
}
