import Autocomplete from '@mui/material/Autocomplete';
import CircularProgress from '@mui/material/CircularProgress';
import ListItem from '@mui/material/ListItem';
import TextField from '@mui/material/TextField';
import React, { Dispatch, SetStateAction, memo, useCallback, useEffect, useState } from 'react';
import { List, ListTag, SundayHomiliesMonthList, listConverter } from '../../types/List';
import firestore, { collection, getDocs, orderBy, query, where } from '../../firebase/firestore';
import { SUNDAY_HOMILIES_STRING } from './consts';
import { UploaderFieldError } from '../../context/types';
import { getErrorMessage, showError } from './utils';

interface SuncayHomilyMonthSelectorProps {
  sermonSubtitle: string;
  date: Date;
  setSermonList: Dispatch<SetStateAction<List[]>>;
  selectedSundayHomiliesMonth: SundayHomiliesMonthList | null;
  setSelectedSundayHomiliesMonth: Dispatch<SetStateAction<SundayHomiliesMonthList | null>>;
  sundayHomiliesYear: number;
  setSundayHomiliesYear: Dispatch<SetStateAction<number>>;
  sundayHomiliesMonthError?: UploaderFieldError;
  setSundayHomiliesMonthError: (error: boolean, message: string, intitialState?: boolean) => void;
}

function SundayHomilyMonthSelector({
  sermonSubtitle,
  date,
  setSermonList,
  selectedSundayHomiliesMonth,
  setSelectedSundayHomiliesMonth,
  sundayHomiliesYear,
  setSundayHomiliesYear,
  sundayHomiliesMonthError,
  setSundayHomiliesMonthError,
}: SuncayHomilyMonthSelectorProps) {
  const [sundayHomiliesMonths, setSundayHomiliesMonths] = useState<SundayHomiliesMonthList[]>([]);
  const [loadingSundayHomiliesMonths, setLoadingSundayHomiliesMonths] = useState(false);

  const fetchSundayHomiliesMonths = useCallback(
    async (year: number) => {
      setLoadingSundayHomiliesMonths(true);
      if (selectedSundayHomiliesMonth) {
        const selectedSundayHomiliesYear = selectedSundayHomiliesMonth.listTagAndPosition.year;
        if (selectedSundayHomiliesYear !== year) {
          setSelectedSundayHomiliesMonth(null);
          setSermonList((oldSermonList) => {
            return oldSermonList.filter((list) => list.listTagAndPosition?.listTag !== ListTag.SUNDAY_HOMILY_MONTH);
          });
        }
      }
      // fetch bible chapters
      const sundayHomiliesMonthsQuery = query(
        collection(firestore, 'lists'),
        where('listTagAndPosition.listTag', '==', ListTag.SUNDAY_HOMILY_MONTH),
        where('listTagAndPosition.year', '==', year),
        orderBy('listTagAndPosition.position', 'asc')
      ).withConverter(listConverter);
      setSundayHomiliesMonths(
        (await getDocs(sundayHomiliesMonthsQuery)).docs.map((doc) => doc.data() as SundayHomiliesMonthList)
      );
      setLoadingSundayHomiliesMonths(false);
    },
    [selectedSundayHomiliesMonth, setSelectedSundayHomiliesMonth, setSermonList]
  );

  useEffect(() => {
    if (sermonSubtitle !== SUNDAY_HOMILIES_STRING) {
      setSundayHomiliesMonthError(false, '');
      setSelectedSundayHomiliesMonth(null);
      setSermonList((oldSermonList) => {
        return oldSermonList.filter((list) => list.listTagAndPosition?.listTag !== ListTag.SUNDAY_HOMILY_MONTH);
      });
    }

    if (!selectedSundayHomiliesMonth) {
      // initialize the initial error state to make sure this field is required if upload is clicked early
      setSundayHomiliesMonthError(true, 'You must select a sunday homily month', true);
    }
  }, [
    sermonSubtitle,
    setSelectedSundayHomiliesMonth,
    setSermonList,
    setSundayHomiliesMonthError,
    selectedSundayHomiliesMonth,
  ]);

  useEffect(() => {
    if (date.getFullYear() !== sundayHomiliesYear) {
      setSundayHomiliesYear(date.getFullYear());
      fetchSundayHomiliesMonths(date.getFullYear());
    }
  }, [date, fetchSundayHomiliesMonths, setSundayHomiliesYear, sundayHomiliesYear]);

  useEffect(() => {
    if (sermonSubtitle === SUNDAY_HOMILIES_STRING && sundayHomiliesMonths.length === 0) {
      fetchSundayHomiliesMonths(date.getFullYear());
    }
  }, [sermonSubtitle, date, sundayHomiliesMonths.length, fetchSundayHomiliesMonths]);

  return (
    <>
      {sermonSubtitle === SUNDAY_HOMILIES_STRING &&
        (loadingSundayHomiliesMonths ? (
          <CircularProgress />
        ) : (
          <Autocomplete
            fullWidth
            value={selectedSundayHomiliesMonth || null}
            isOptionEqualToValue={(option, value) => option?.id === value?.id}
            onBlur={() => {
              if (!selectedSundayHomiliesMonth) {
                setSundayHomiliesMonthError(true, 'You must select a sunday homily month');
              } else {
                setSundayHomiliesMonthError(false, '');
              }
            }}
            onChange={async (_, newValue) => {
              setSelectedSundayHomiliesMonth(newValue);
              setSermonList((oldSermonList) => {
                if (!newValue) {
                  return oldSermonList.filter(
                    (list) => list.listTagAndPosition?.listTag !== ListTag.SUNDAY_HOMILY_MONTH
                  );
                }
                setSundayHomiliesMonthError(false, '');
                const filteredList = oldSermonList.filter(
                  (list) =>
                    list.name !== SUNDAY_HOMILIES_STRING &&
                    list.listTagAndPosition?.listTag !== ListTag.SUNDAY_HOMILY_MONTH
                );
                return [...filteredList, newValue];
              });
            }}
            id="sunday-homilies-months-input"
            options={sundayHomiliesMonths}
            getOptionLabel={(option: List) => option.name}
            renderOption={(props, option: List) => (
              <ListItem {...props} key={option.id}>
                {option.name}
              </ListItem>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                required
                error={showError(sundayHomiliesMonthError)}
                helperText={getErrorMessage(sundayHomiliesMonthError)}
                label="Month"
              />
            )}
          />
        ))}
    </>
  );
}

export default memo(SundayHomilyMonthSelector);
