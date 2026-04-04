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
