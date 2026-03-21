import { FunctionOutputType } from '@upperroom/shared/types/Function';

export interface UpdateAllSpeakerTagsInputType {
  dryRun?: boolean;
}

export interface UpdateAllSpeakerTagsResultType {
  totalSpeakers: number;
  updatedCount: number;
  skippedNoTagCount: number;
  skippedNoSquareImageCount: number;
  skippedNoNameCount: number;
  failedCount: number;
  processedSpeakerIds: string[];
  failedSpeakers: Array<{
    speakerId: string;
    name: string;
    error: string;
  }>;
  abortedDueToRateLimit: boolean;
  retryAfterMs?: number;
}

export type UpdateAllSpeakerTagsOutputType = FunctionOutputType<UpdateAllSpeakerTagsResultType>;
