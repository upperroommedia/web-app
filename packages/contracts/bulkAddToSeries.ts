export interface BulkAddToSeriesInputType {
  firestoreSeriesId: string;
  seriesSubsplashId: string;
  operationKey: string;
  expectedPublishedMembershipHash: string;
  adds: Array<{
    mediaItemId: string;
    sermonId?: string;
  }>;
  publishedItemOrder: string[];
  maxConcurrency?: number;
  rollbackOnFailure?: boolean;
}

export interface BulkAddToSeriesResultItem {
  mediaItemId: string;
  sermonId?: string;
  status: 'success' | 'error';
  confirmedSeriesId?: string | null;
  position?: number | null;
  alreadyInSeries?: boolean;
  error?: string;
}

export interface BulkAddToSeriesOutputType {
  status: 'success' | 'partial' | 'error';
  message: string;
  firestoreSeriesId: string;
  seriesSubsplashId: string;
  processed: number;
  succeeded: number;
  failed: number;
  reorderApplied: boolean;
  results: BulkAddToSeriesResultItem[];
  rolledBackMediaItemIds: string[];
  rollbackFailures: Array<{ mediaItemId: string; error: string }>;
}
