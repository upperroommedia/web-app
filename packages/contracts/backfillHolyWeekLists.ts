import { FunctionOutputType } from '@upperroom/shared/types/Function';
import { HolyWeekDay } from '@upperroom/shared/types/List';

export interface BackfillHolyWeekListsInputType {
  dryRun?: boolean;
}

export interface BackfillHolyWeekListsResultType {
  sourceListId: string;
  totalYearRows: number;
  createdYearLists: number;
  updatedYearLists: number;
  skippedYearLists: number;
  taggedDayLists: number;
  duplicateYears: Array<{
    year: number;
    listIds: string[];
  }>;
  invalidTitles: Array<{
    listId: string;
    title: string;
  }>;
  processedYearLists: Array<{
    year: number;
    listId: string;
    title: string;
  }>;
  processedDayLists: Array<{
    day: HolyWeekDay;
    listId: string;
    title: string;
  }>;
}

export type BackfillHolyWeekListsOutputType = FunctionOutputType<BackfillHolyWeekListsResultType>;
