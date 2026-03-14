import type { Order } from '../../context/types';
import type { ISpeaker } from '../../types/Speaker';

export type SpeakerSortableProperty = Extract<keyof ISpeaker, 'name' | 'sermonCount'>;

export const SPEAKER_PRIMARY_INDEX_NAME = 'speakers';

export const SPEAKER_SORT_INDEX_NAMES: Record<SpeakerSortableProperty, Record<Order, string>> = {
  name: {
    asc: 'speakers_sort_name_asc',
    desc: 'speakers_sort_name_desc',
  },
  sermonCount: {
    asc: 'speakers_sort_sermonCount_asc',
    desc: 'speakers_sort_sermonCount_desc',
  },
};

const SPEAKER_SORTABLE_PROPERTIES = new Set<SpeakerSortableProperty>(['name', 'sermonCount']);

export const isSpeakerSortableProperty = (value: keyof ISpeaker): value is SpeakerSortableProperty =>
  SPEAKER_SORTABLE_PROPERTIES.has(value as SpeakerSortableProperty);

export const getDefaultSpeakerSortOrder = (property: SpeakerSortableProperty): Order =>
  property === 'sermonCount' ? 'desc' : 'asc';

export const resolveSpeakerIndexName = (sortProperty: keyof ISpeaker, sortOrder: Order): string => {
  if (!isSpeakerSortableProperty(sortProperty)) {
    return SPEAKER_PRIMARY_INDEX_NAME;
  }

  return SPEAKER_SORT_INDEX_NAMES[sortProperty][sortOrder];
};

export const resolveSpeakerSortFromIndexName = (
  indexName: string
): { sortProperty: SpeakerSortableProperty; sortOrder: Order } => {
  for (const sortProperty of Object.keys(SPEAKER_SORT_INDEX_NAMES) as SpeakerSortableProperty[]) {
    for (const sortOrder of Object.keys(SPEAKER_SORT_INDEX_NAMES[sortProperty]) as Order[]) {
      if (SPEAKER_SORT_INDEX_NAMES[sortProperty][sortOrder] === indexName) {
        return { sortProperty, sortOrder };
      }
    }
  }

  return {
    sortProperty: 'name',
    sortOrder: 'asc',
  };
};
