import {
  HOLY_WEEK_DAY_LABELS,
  replaceHolyWeekLists,
  sortHolyWeekDayLists,
  sortHolyWeekYearLists,
} from '../../utils/holyWeek';
import { PASCHA_WEEK_STRING } from '../../components/uploaderComponents/consts';
import { HolyWeekDay, HolyWeekKind, ListTag, ListType, OverflowBehavior, type HolyWeekDayList, type HolyWeekYearList } from '../../types/List';

const buildBaseList = () => ({
  id: 'list',
  name: 'List',
  images: [],
  overflowBehavior: OverflowBehavior.CREATENEWLIST,
  type: ListType.SERIES,
  createdAtMillis: 1,
  updatedAtMillis: 1,
});

const buildHolyWeekYearList = (year: number, id: string): HolyWeekYearList => ({
  ...buildBaseList(),
  id,
  name: `Pascha Week ${year}`,
  listTagAndPosition: {
    listTag: ListTag.HOLY_WEEK,
    holyWeekKind: HolyWeekKind.YEAR,
    position: year,
    year,
  },
});

const buildHolyWeekDayList = (day: HolyWeekDay, position: number, id: string): HolyWeekDayList => ({
  ...buildBaseList(),
  id,
  name: HOLY_WEEK_DAY_LABELS[day],
  listTagAndPosition: {
    listTag: ListTag.HOLY_WEEK,
    holyWeekKind: HolyWeekKind.DAY,
    position,
    day,
  },
});

describe('holyWeek helpers', () => {
  it('replaces the generic Pascha category list with selected Holy Week year/day lists', () => {
    const genericPaschaList = {
      ...buildBaseList(),
      id: 'pascha-category',
      type: ListType.CATEGORY_LIST,
      name: PASCHA_WEEK_STRING,
    };
    const unrelatedTopicList = {
      ...buildBaseList(),
      id: 'topic-1',
      type: ListType.TOPIC_LIST,
      name: 'Holy Week',
    };
    const yearList = buildHolyWeekYearList(2024, 'year-2024');
    const dayList = buildHolyWeekDayList(HolyWeekDay.GOOD_FRIDAY, 6, 'day-good-friday');

    expect(replaceHolyWeekLists([genericPaschaList, unrelatedTopicList], yearList, dayList)).toEqual([
      unrelatedTopicList,
      yearList,
      dayList,
    ]);
  });

  it('sorts Holy Week year lists newest first', () => {
    const years = sortHolyWeekYearLists([
      buildHolyWeekYearList(2022, 'year-2022'),
      buildHolyWeekYearList(2024, 'year-2024'),
      buildHolyWeekYearList(2023, 'year-2023'),
    ]);

    expect(years.map((list) => list.listTagAndPosition.year)).toEqual([2024, 2023, 2022]);
  });

  it('sorts Holy Week day lists in liturgical order', () => {
    const days = sortHolyWeekDayLists([
      buildHolyWeekDayList(HolyWeekDay.RESURRECTION, 8, 'day-resurrection'),
      buildHolyWeekDayList(HolyWeekDay.PALM_SUNDAY, 1, 'day-palm-sunday'),
      buildHolyWeekDayList(HolyWeekDay.GOOD_FRIDAY, 6, 'day-good-friday'),
    ]);

    expect(days.map((list) => list.listTagAndPosition.day)).toEqual([
      HolyWeekDay.PALM_SUNDAY,
      HolyWeekDay.GOOD_FRIDAY,
      HolyWeekDay.RESURRECTION,
    ]);
  });
});
