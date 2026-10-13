import type { SermonList } from '../types/SermonList';
import { uploadStatus } from '../types/SermonTypes';

/** The browser selects destinations. The server resolves provider identities and performs all effects. */
export function buildSermonPublishIntent(input: {
  lists: SermonList[];
  selectedListIds: readonly string[];
  seriesId?: string;
  seriesSelected: boolean;
  seriesPublished: boolean;
  soundcloudSelected: boolean;
  soundcloudPublished: boolean;
}) {
  const selected = new Set(input.selectedListIds);
  return {
    destinations: {
      listIds: input.lists
        .filter((list) => selected.has(list.id) && list.uploadStatus?.status !== uploadStatus.UPLOADED)
        .map((list) => list.id)
        .sort(),
      ...(input.seriesId && input.seriesSelected && !input.seriesPublished ? { seriesId: input.seriesId } : {}),
      soundcloud: input.soundcloudSelected && !input.soundcloudPublished,
    },
    removals: {
      listIds: input.lists
        .filter((list) => !selected.has(list.id) && list.uploadStatus?.status === uploadStatus.UPLOADED)
        .map((list) => list.id)
        .sort(),
      ...(input.seriesId && !input.seriesSelected && input.seriesPublished ? { seriesId: input.seriesId } : {}),
      soundcloud: !input.soundcloudSelected && input.soundcloudPublished,
    },
  };
}

export function hasPublishIntentChanges(payload: ReturnType<typeof buildSermonPublishIntent>) {
  return [payload.destinations, payload.removals].some(
    (selection) => selection.listIds.length > 0 || Boolean(selection.seriesId) || selection.soundcloud
  );
}
