export type SeriesItemPublishChipState = {
  isBusy: boolean;
  label: string;
  tooltip: string;
  color: 'default' | 'info' | 'success' | 'warning';
  variant: 'filled' | 'outlined';
};

interface SeriesItemPublishChipStateInput {
  publishedToSubsplash: boolean;
  isPublishing: boolean;
  isUnpublishing: boolean;
}

export const getSeriesItemPublishChipState = ({
  publishedToSubsplash,
  isPublishing,
  isUnpublishing,
}: SeriesItemPublishChipStateInput): SeriesItemPublishChipState => {
  const isBusy = isPublishing || isUnpublishing;

  if (isBusy) {
    return {
      isBusy: true,
      label: isUnpublishing ? 'Unpublishing' : 'Publishing',
      tooltip: isUnpublishing
        ? 'Unpublishing from Subsplash series…'
        : 'Publishing to Subsplash series…',
      color: 'info',
      variant: 'filled',
    };
  }

  if (publishedToSubsplash) {
    return {
      isBusy: false,
      label: 'Published',
      tooltip: 'Published to Subsplash series',
      color: 'success',
      variant: 'filled',
    };
  }

  return {
    isBusy: false,
    label: 'Not Published',
    tooltip: 'Not published to Subsplash series',
    color: 'warning',
    variant: 'outlined',
  };
};
