import { SermonList } from '../types/SermonList';
import { uploadStatus } from '../types/SermonTypes';

export interface AdvancedSelectionSummaryInput {
  publishListCount: number;
  unpublishListCount: number;
  publishSeries: boolean;
  unpublishSeries: boolean;
  publishSoundCloud: boolean;
  unpublishSoundCloud: boolean;
}

export interface AdvancedSelectionSummary {
  label: string;
  hasChanges: boolean;
  hasPublishChanges: boolean;
  hasUnpublishChanges: boolean;
  isMixedDirection: boolean;
  isPureUnpublish: boolean;
}

export interface BasicPublishActionPlanInput {
  lists: SermonList[];
  hasSeriesId: boolean;
  seriesPublished: boolean | null;
  canPublishToSeries: boolean;
  isSoundCloudUploaded: boolean;
  isDevelopment: boolean;
}

export interface BasicPublishActionPlan {
  publishListIds: string[];
  unpublishListIds: string[];
  publishSeries: boolean;
  unpublishSeries: boolean;
  publishSoundCloud: boolean;
  unpublishSoundCloud: boolean;
  publishLabel: string;
  hasPublishTargets: boolean;
  hasUnpublishTargets: boolean;
  showPublishButton: boolean;
  showUnpublishButton: boolean;
}

export type DestinationOperation = 'idle' | 'publish' | 'unpublish';

export interface DestinationActivityState {
  listOperation: DestinationOperation;
  listIds: string[];
  seriesOperation: DestinationOperation;
  soundCloudOperation: DestinationOperation;
}

const formatParts = (parts: string[]): string => parts.join(', ');

export const summarizeAdvancedSelectionChanges = (
  input: AdvancedSelectionSummaryInput
): AdvancedSelectionSummary => {
  const publishParts: string[] = [];
  const unpublishParts: string[] = [];

  if (input.publishListCount > 0) {
    publishParts.push(`${input.publishListCount} list${input.publishListCount === 1 ? '' : 's'}`);
  }
  if (input.publishSeries) {
    publishParts.push('series');
  }
  if (input.publishSoundCloud) {
    publishParts.push('SoundCloud');
  }

  if (input.unpublishListCount > 0) {
    unpublishParts.push(`${input.unpublishListCount} list${input.unpublishListCount === 1 ? '' : 's'}`);
  }
  if (input.unpublishSeries) {
    unpublishParts.push('series');
  }
  if (input.unpublishSoundCloud) {
    unpublishParts.push('SoundCloud');
  }

  const hasPublishChanges = publishParts.length > 0;
  const hasUnpublishChanges = unpublishParts.length > 0;
  const hasChanges = hasPublishChanges || hasUnpublishChanges;
  const isMixedDirection = hasPublishChanges && hasUnpublishChanges;
  const isPureUnpublish = hasUnpublishChanges && !hasPublishChanges;

  if (isMixedDirection) {
    return {
      label: `Publish to ${formatParts(publishParts)} and unpublish from ${formatParts(unpublishParts)}`,
      hasChanges,
      hasPublishChanges,
      hasUnpublishChanges,
      isMixedDirection,
      isPureUnpublish,
    };
  }

  if (hasPublishChanges) {
    return {
      label: `Publish to ${formatParts(publishParts)}`,
      hasChanges,
      hasPublishChanges,
      hasUnpublishChanges,
      isMixedDirection,
      isPureUnpublish,
    };
  }

  if (hasUnpublishChanges) {
    return {
      label: `Unpublish from ${formatParts(unpublishParts)}`,
      hasChanges,
      hasPublishChanges,
      hasUnpublishChanges,
      isMixedDirection,
      isPureUnpublish,
    };
  }

  return {
    label: 'No destination changes selected',
    hasChanges: false,
    hasPublishChanges: false,
    hasUnpublishChanges: false,
    isMixedDirection: false,
    isPureUnpublish: false,
  };
};

export const buildBasicPublishActionPlan = (
  input: BasicPublishActionPlanInput
): BasicPublishActionPlan => {
  const publishListIds = input.lists
    .filter((list) => list.uploadStatus?.status !== uploadStatus.UPLOADED)
    .map((list) => list.id);
  const unpublishListIds = input.lists
    .filter((list) => list.uploadStatus?.status === uploadStatus.UPLOADED)
    .map((list) => list.id);
  const publishSeries = Boolean(
    input.hasSeriesId
    && input.seriesPublished !== true
    && input.canPublishToSeries
  );
  const unpublishSeries = Boolean(input.hasSeriesId && input.seriesPublished === true);
  const publishSoundCloud = !input.isDevelopment && !input.isSoundCloudUploaded;
  const unpublishSoundCloud = input.isSoundCloudUploaded;

  const publishSummary = summarizeAdvancedSelectionChanges({
    publishListCount: publishListIds.length,
    unpublishListCount: 0,
    publishSeries,
    unpublishSeries: false,
    publishSoundCloud,
    unpublishSoundCloud: false,
  });

  return {
    publishListIds,
    unpublishListIds,
    publishSeries,
    unpublishSeries,
    publishSoundCloud,
    unpublishSoundCloud,
    publishLabel: publishSummary.hasPublishChanges ? publishSummary.label : 'Nothing to publish',
    hasPublishTargets: publishSummary.hasPublishChanges,
    hasUnpublishTargets: unpublishListIds.length > 0 || unpublishSeries || unpublishSoundCloud,
    showPublishButton: publishSummary.hasPublishChanges,
    showUnpublishButton: unpublishListIds.length > 0 || unpublishSeries || unpublishSoundCloud,
  };
};

export const createIdleDestinationActivityState = (): DestinationActivityState => ({
  listOperation: 'idle',
  listIds: [],
  seriesOperation: 'idle',
  soundCloudOperation: 'idle',
});
