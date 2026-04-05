import Autocomplete from '@mui/material/Autocomplete';
import CircularProgress from '@mui/material/CircularProgress';
import ListItem from '@mui/material/ListItem';
import TextField from '@mui/material/TextField';
import React, { Dispatch, SetStateAction, memo, useEffect, useMemo, useState } from 'react';
import firestore, { collection, getDocs, orderBy, query, where } from '../../firebase/firestore';
import {
  HolyWeekDayList,
  HolyWeekYearList,
  List,
  ListTag,
  listConverter,
} from '../../types/List';
import { UploaderFieldError } from '../../context/types';
import { getErrorMessage, showError } from './utils';
import { PASCHA_WEEK_STRING } from './consts';
import { getHolyWeekListsFromBundle } from '../../utils/bundleHelpers';
import {
  HOLY_WEEK_DAY_LABELS,
  isHolyWeekDayList,
  isHolyWeekYearList,
  replaceHolyWeekLists,
  sortHolyWeekDayLists,
  sortHolyWeekYearLists,
} from '../../utils/holyWeek';

interface HolyWeekSelectorProps {
  sermonSubtitle: string;
  setSermonList: Dispatch<SetStateAction<List[]>>;
  selectedHolyWeekYear: HolyWeekYearList | null;
  setSelectedHolyWeekYear: Dispatch<SetStateAction<HolyWeekYearList | null>>;
  selectedHolyWeekDay: HolyWeekDayList | null;
  setSelectedHolyWeekDay: Dispatch<SetStateAction<HolyWeekDayList | null>>;
  holyWeekYearError?: UploaderFieldError;
  setHolyWeekYearError: (error: boolean, message: string, initialState?: boolean) => void;
  holyWeekDayError?: UploaderFieldError;
  setHolyWeekDayError: (error: boolean, message: string, initialState?: boolean) => void;
}

function HolyWeekSelector({
  sermonSubtitle,
  setSermonList,
  selectedHolyWeekYear,
  setSelectedHolyWeekYear,
  selectedHolyWeekDay,
  setSelectedHolyWeekDay,
  holyWeekYearError,
  setHolyWeekYearError,
  holyWeekDayError,
  setHolyWeekDayError,
}: HolyWeekSelectorProps) {
  const [loadingHolyWeekLists, setLoadingHolyWeekLists] = useState(false);
  const [holyWeekLists, setHolyWeekLists] = useState<List[]>([]);

  useEffect(() => {
    if (sermonSubtitle !== PASCHA_WEEK_STRING) {
      return;
    }

    setSermonList((oldSermonList) => {
      const nextSermonList = replaceHolyWeekLists(oldSermonList, selectedHolyWeekYear, selectedHolyWeekDay);
      const hasChanged =
        oldSermonList.length !== nextSermonList.length ||
        oldSermonList.some((list, index) => list.id !== nextSermonList[index]?.id);

      return hasChanged ? nextSermonList : oldSermonList;
    });
  }, [selectedHolyWeekDay, selectedHolyWeekYear, sermonSubtitle, setSermonList]);

  useEffect(() => {
    if (sermonSubtitle !== PASCHA_WEEK_STRING) {
      setHolyWeekYearError(false, '');
      setHolyWeekDayError(false, '');
      setSelectedHolyWeekYear(null);
      setSelectedHolyWeekDay(null);
      setSermonList((oldSermonList) =>
        oldSermonList.filter((list) => list.listTagAndPosition?.listTag !== ListTag.HOLY_WEEK)
      );
      return;
    }

    if (!selectedHolyWeekYear) {
      setHolyWeekYearError(true, 'You must select a Pascha week year', true);
    }
    if (!selectedHolyWeekDay) {
      setHolyWeekDayError(true, 'You must select a Holy Week day', true);
    }

    if (holyWeekLists.length > 0) {
      return;
    }

    const fetchHolyWeekLists = async () => {
      setLoadingHolyWeekLists(true);
      try {
        const listsFromBundle = await getHolyWeekListsFromBundle();
        setHolyWeekLists(listsFromBundle);
      } catch (error) {
        console.error('Error loading Holy Week lists from bundle, falling back to Firestore:', error);
        const holyWeekQuery = query(
          collection(firestore, 'lists'),
          where('listTagAndPosition.listTag', '==', ListTag.HOLY_WEEK),
          orderBy('listTagAndPosition.position', 'asc')
        ).withConverter(listConverter);
        const lists = (await getDocs(holyWeekQuery)).docs.map((doc) => doc.data());
        setHolyWeekLists(lists);
      } finally {
        setLoadingHolyWeekLists(false);
      }
    };

    fetchHolyWeekLists();
  }, [
    holyWeekLists.length,
    selectedHolyWeekDay,
    selectedHolyWeekYear,
    sermonSubtitle,
    setHolyWeekDayError,
    setHolyWeekYearError,
    setSelectedHolyWeekDay,
    setSelectedHolyWeekYear,
    setSermonList,
  ]);

  const yearOptions = useMemo(
    () => sortHolyWeekYearLists(holyWeekLists.filter(isHolyWeekYearList)),
    [holyWeekLists]
  );
  const dayOptions = useMemo(
    () => sortHolyWeekDayLists(holyWeekLists.filter(isHolyWeekDayList)),
    [holyWeekLists]
  );

  const updateHolyWeekLists = (
    nextYearList: HolyWeekYearList | null,
    nextDayList: HolyWeekDayList | null
  ) => {
    setSermonList((oldSermonList) => replaceHolyWeekLists(oldSermonList, nextYearList, nextDayList));
  };

  if (sermonSubtitle !== PASCHA_WEEK_STRING) {
    return null;
  }

  if (loadingHolyWeekLists) {
    return <CircularProgress />;
  }

  return (
    <>
      <Autocomplete
        fullWidth
        value={selectedHolyWeekYear}
        options={yearOptions}
        isOptionEqualToValue={(option, value) => option?.id === value?.id}
        onBlur={() => {
          if (!selectedHolyWeekYear) {
            setHolyWeekYearError(true, 'You must select a Pascha week year');
          } else {
            setHolyWeekYearError(false, '');
          }
        }}
        onChange={(_, newValue) => {
          setSelectedHolyWeekYear(newValue);
          setHolyWeekYearError(!newValue, 'You must select a Pascha week year');
          updateHolyWeekLists(newValue, selectedHolyWeekDay);
        }}
        getOptionLabel={(option) => `${option.listTagAndPosition.year}`}
        renderOption={(props, option) => {
          const { key: _key, ...optionProps } = props;
          return (
            <ListItem key={option.id} {...optionProps}>
              {option.name}
            </ListItem>
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            required
            label="Pascha Year"
            error={showError(holyWeekYearError)}
            helperText={getErrorMessage(holyWeekYearError)}
          />
        )}
      />
      <Autocomplete
        fullWidth
        value={selectedHolyWeekDay}
        options={dayOptions}
        isOptionEqualToValue={(option, value) => option?.id === value?.id}
        onBlur={() => {
          if (!selectedHolyWeekDay) {
            setHolyWeekDayError(true, 'You must select a Holy Week day');
          } else {
            setHolyWeekDayError(false, '');
          }
        }}
        onChange={(_, newValue) => {
          setSelectedHolyWeekDay(newValue);
          setHolyWeekDayError(!newValue, 'You must select a Holy Week day');
          updateHolyWeekLists(selectedHolyWeekYear, newValue);
        }}
        getOptionLabel={(option) => HOLY_WEEK_DAY_LABELS[option.listTagAndPosition.day]}
        renderOption={(props, option) => {
          const { key: _key, ...optionProps } = props;
          return (
            <ListItem key={option.id} {...optionProps}>
              {HOLY_WEEK_DAY_LABELS[option.listTagAndPosition.day]}
            </ListItem>
          );
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            required
            label="Holy Week Day"
            error={showError(holyWeekDayError)}
            helperText={getErrorMessage(holyWeekDayError)}
          />
        )}
      />
    </>
  );
}

export default memo(HolyWeekSelector);
