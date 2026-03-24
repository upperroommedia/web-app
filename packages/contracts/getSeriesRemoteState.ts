export interface GetSeriesRemoteStateInputType {
  firestoreSeriesId: string;
}

export type SeriesRemoteItemStatus = 'published' | 'draft' | 'scheduled';

export interface GetSeriesRemoteStateRemoteItem {
  mediaItemId: string;
  logicalPosition: number;
  remoteStatus: SeriesRemoteItemStatus;
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  imageType?: string;
  matchedSermonId?: string;
  matchedSeriesItemId?: string;
  isTrackedInFirebase: boolean;
  publishedToSubsplashInFirebase: boolean;
  isSubsplashOnlyPlaceholder: boolean;
  canReorder: boolean;
  canUnpublish: boolean;
  canRemoveLocally: boolean;
}

export interface GetSeriesRemoteStateOutputType {
  firestoreSeriesId: string;
  subsplashSeriesId: string;
  remoteMembershipHash: string;
  totalRemoteItems: number;
  trackedFirebaseItems: number;
  remoteOnlyItemCount: number;
  canReorder: boolean;
  remoteItems: GetSeriesRemoteStateRemoteItem[];
}
