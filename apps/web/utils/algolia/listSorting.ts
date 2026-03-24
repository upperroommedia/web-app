import type { Order } from '../../context/types';
import type { List } from '../../types/List';

export type ListSortableProperty = Extract<keyof List, 'name'>;

export const LIST_PRIMARY_INDEX_NAME = 'lists';

export const LIST_SORT_INDEX_NAMES: Record<ListSortableProperty, Record<Order, string>> = {
  name: {
    asc: 'lists_sort_name_asc',
    desc: 'lists_sort_name_desc',
  },
};

const LIST_SORTABLE_PROPERTIES = new Set<ListSortableProperty>(['name']);

export const isListSortableProperty = (value: keyof List): value is ListSortableProperty =>
  LIST_SORTABLE_PROPERTIES.has(value as ListSortableProperty);

export const getDefaultListSortOrder = (_property: ListSortableProperty): Order => 'asc';

export const resolveListIndexName = (sortProperty: keyof List, sortOrder: Order): string => {
  if (!isListSortableProperty(sortProperty)) {
    return LIST_PRIMARY_INDEX_NAME;
  }

  return LIST_SORT_INDEX_NAMES[sortProperty][sortOrder];
};

export const resolveListSortFromIndexName = (
  indexName: string
): { sortProperty: ListSortableProperty; sortOrder: Order } => {
  for (const sortProperty of Object.keys(LIST_SORT_INDEX_NAMES) as ListSortableProperty[]) {
    for (const sortOrder of Object.keys(LIST_SORT_INDEX_NAMES[sortProperty]) as Order[]) {
      if (LIST_SORT_INDEX_NAMES[sortProperty][sortOrder] === indexName) {
        return { sortProperty, sortOrder };
      }
    }
  }

  return {
    sortProperty: 'name',
    sortOrder: 'asc',
  };
};
