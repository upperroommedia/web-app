import { removeCategoryScopedLists } from '../../utils/categoryScopedLists';
import { HolyWeekKind, ListTag, ListType, OverflowBehavior } from '../../types/List';

const buildBaseList = () => ({
  id: 'list',
  name: 'List',
  images: [],
  overflowBehavior: OverflowBehavior.CREATENEWLIST,
  type: ListType.SERIES,
  createdAtMillis: 1,
  updatedAtMillis: 1,
});

describe('removeCategoryScopedLists', () => {
  it('removes generic category lists and category-scoped tagged lists only', () => {
    const genericCategoryList = {
      ...buildBaseList(),
      id: 'category-list',
      type: ListType.CATEGORY_LIST,
      name: 'Bible Studies',
    };
    const bibleChapterList = {
      ...buildBaseList(),
      id: 'genesis-1',
      name: 'Genesis 1',
      listTagAndPosition: {
        listTag: ListTag.BIBLE_CHAPTER,
        position: 1,
      },
    };
    const holyWeekYearList = {
      ...buildBaseList(),
      id: 'pascha-2024',
      name: 'Pascha Week 2024',
      listTagAndPosition: {
        listTag: ListTag.HOLY_WEEK,
        holyWeekKind: HolyWeekKind.YEAR,
        position: 1,
        year: 2024,
      },
    };
    const topicList = {
      ...buildBaseList(),
      id: 'topic-1',
      type: ListType.TOPIC_LIST,
      name: 'Repentance',
    };
    const latestList = {
      ...buildBaseList(),
      id: 'latest',
      name: 'Latest',
    };

    expect(
      removeCategoryScopedLists([genericCategoryList, bibleChapterList, holyWeekYearList, topicList, latestList])
    ).toEqual([topicList, latestList]);
  });
});
