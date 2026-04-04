import type { Reference } from 'firebase-admin/database';

export type ProcessAudioProgressStage =
  | 'queued'
  | 'downloading'
  | 'transcoding'
  | 'trimming'
  | 'finalizing'
  | 'completed';

export interface ProcessAudioProgressState {
  percent: number;
  stage: ProcessAudioProgressStage;
  stageLabel: string;
  updatedAt: string;
}

function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function buildProcessAudioProgressState(
  percent: number,
  stage: ProcessAudioProgressStage,
  stageLabel: string
): ProcessAudioProgressState {
  return {
    percent: clampPercent(percent),
    stage,
    stageLabel,
    updatedAt: new Date().toISOString(),
  };
}

export async function setProcessAudioProgress(
  ref: Reference,
  percent: number,
  stage: ProcessAudioProgressStage,
  stageLabel: string
): Promise<void> {
  await ref.set(buildProcessAudioProgressState(percent, stage, stageLabel));
}
