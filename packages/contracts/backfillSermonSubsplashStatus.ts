import { FunctionOutputType } from '@upperroom/shared/types/Function';

export interface BackfillSermonSubsplashStatusInputType {
  dryRun?: boolean;
}

export interface BackfillSermonSubsplashStatusResultType {
  totalSermons: number;
  updatedCount: number;
  alreadyCorrectCount: number;
  processedSermonIds: string[];
}

export type BackfillSermonSubsplashStatusOutputType = FunctionOutputType<BackfillSermonSubsplashStatusResultType>;
