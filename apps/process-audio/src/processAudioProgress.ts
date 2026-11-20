export type ProcessAudioProgressStage =
  | 'queued'
  | 'processing'
  | 'downloading'
  | 'transcoding'
  | 'trimming'
  | 'finalizing'
  | 'completed';

export interface ProcessAudioProgressState {
  percent: number;
  stagePercent?: number;
  overallPercent?: number;
  stage: ProcessAudioProgressStage;
  stageLabel: string;
  updatedAt: string;
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function buildProcessAudioProgressState(
  overallPercent: number,
  stage: ProcessAudioProgressStage,
  stageLabel: string,
  stagePercent?: number
): ProcessAudioProgressState {
  const normalizedOverallPercent = clampPercent(overallPercent);
  const normalizedStagePercent = stagePercent === undefined ? normalizedOverallPercent : clampPercent(stagePercent);

  return {
    percent: normalizedStagePercent,
    stagePercent: normalizedStagePercent,
    overallPercent: normalizedOverallPercent,
    stage,
    stageLabel,
    updatedAt: new Date().toISOString(),
  };
}

export interface ProcessAudioProgressTarget {
  set(progress: ProcessAudioProgressState): Promise<unknown>;
}

export async function setProcessAudioProgress(
  ref: ProcessAudioProgressTarget,
  overallPercent: number,
  stage: ProcessAudioProgressStage,
  stageLabel: string,
  stagePercent?: number
): Promise<void> {
  await ref.set(buildProcessAudioProgressState(overallPercent, stage, stageLabel, stagePercent));
}
