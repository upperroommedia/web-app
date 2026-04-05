import { List, ListTag, ListType } from '../types/List';

const CATEGORY_SCOPED_LIST_TAGS = new Set<ListTag>([
  ListTag.BIBLE_CHAPTER,
  ListTag.SUNDAY_HOMILY_MONTH,
  ListTag.HOLY_WEEK,
]);

export const removeCategoryScopedLists = (lists: List[]): List[] => {
  return lists.filter((list) => {
    if (list.type === ListType.CATEGORY_LIST) {
      return false;
    }

    const tag = list.listTagAndPosition?.listTag;
    return !tag || !CATEGORY_SCOPED_LIST_TAGS.has(tag);
  });
};
