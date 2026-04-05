import { HolyWeekDay, HolyWeekKind, List, ListTag, ListType, type HolyWeekDayList, type HolyWeekYearList } from '../types/List';
import { PASCHA_WEEK_STRING } from '../components/uploaderComponents/consts';

export const HOLY_WEEK_DAY_LABELS: Record<HolyWeekDay, string> = {
  [HolyWeekDay.PALM_SUNDAY]: 'Palm Sunday',
  [HolyWeekDay.HOLY_MONDAY]: 'Holy Monday',
  [HolyWeekDay.HOLY_TUESDAY]: 'Holy Tuesday',
  [HolyWeekDay.HOLY_WEDNESDAY]: 'Holy Wednesday',
  [HolyWeekDay.COVENANT_THURSDAY]: 'Covenant Thursday',
  [HolyWeekDay.GOOD_FRIDAY]: 'Good Friday',
  [HolyWeekDay.JOYOUS_SATURDAY]: 'Joyous Saturday',
  [HolyWeekDay.RESURRECTION]: 'Resurrection',
};

export const HOLY_WEEK_DAY_ORDER: HolyWeekDay[] = [
  HolyWeekDay.PALM_SUNDAY,
  HolyWeekDay.HOLY_MONDAY,
  HolyWeekDay.HOLY_TUESDAY,
  HolyWeekDay.HOLY_WEDNESDAY,
  HolyWeekDay.COVENANT_THURSDAY,
  HolyWeekDay.GOOD_FRIDAY,
  HolyWeekDay.JOYOUS_SATURDAY,
  HolyWeekDay.RESURRECTION,
];

const isHolyWeekList = (list: List): boolean => list.listTagAndPosition?.listTag === ListTag.HOLY_WEEK;

export const isHolyWeekYearList = (list: List): list is HolyWeekYearList => {
  const tag = list.listTagAndPosition;
  return tag?.listTag === ListTag.HOLY_WEEK && 'holyWeekKind' in tag && tag.holyWeekKind === HolyWeekKind.YEAR;
};

export const isHolyWeekDayList = (list: List): list is HolyWeekDayList => {
  const tag = list.listTagAndPosition;
  return tag?.listTag === ListTag.HOLY_WEEK && 'holyWeekKind' in tag && tag.holyWeekKind === HolyWeekKind.DAY;
};

export const sortHolyWeekYearLists = (lists: HolyWeekYearList[]): HolyWeekYearList[] => {
  return [...lists].sort((first, second) => second.listTagAndPosition.year - first.listTagAndPosition.year);
};

export const sortHolyWeekDayLists = (lists: HolyWeekDayList[]): HolyWeekDayList[] => {
  return [...lists].sort((first, second) => {
    return HOLY_WEEK_DAY_ORDER.indexOf(first.listTagAndPosition.day) - HOLY_WEEK_DAY_ORDER.indexOf(second.listTagAndPosition.day);
  });
};

export const replaceHolyWeekLists = (
  sermonList: List[],
  yearList: HolyWeekYearList | null,
  dayList: HolyWeekDayList | null
): List[] => {
  const filteredLists = sermonList.filter(
    (list) => !isHolyWeekList(list) && !(list.type === ListType.CATEGORY_LIST && list.name === PASCHA_WEEK_STRING)
  );
  return [...filteredLists, ...(yearList ? [yearList] : []), ...(dayList ? [dayList] : [])];
};
