import Autocomplete from '@mui/material/Autocomplete';
import CircularProgress from '@mui/material/CircularProgress';
import ListItem from '@mui/material/ListItem';
import TextField from '@mui/material/TextField';
import React, { Dispatch, SetStateAction, memo, useCallback, useEffect, useState } from 'react';
import { List, ListTag, SundayHomiliesMonthList, listConverter } from '../../types/List';
import firestore, { collection, getDocs, orderBy, query, where } from '../../firebase/firestore';
import { SUNDAY_HOMILIES_STRING } from './consts';

interface SuncayHomilyMonthSelectorProps {
  sermonSubtitle: string;
  date: Date;
  setSermonList: Dispatch<SetStateAction<List[]>>;
  selectedSundayHomiliesMonth: SundayHomiliesMonthList | null;
  setSelectedSundayHomiliesMonth: Dispatch<SetStateAction<SundayHomiliesMonthList | null>>;
  sundayHomiliesYear: number;
  setSundayHomiliesYear: Dispatch<SetStateAction<number>>;
}

function SundayHomilyMonthSelector({
  sermonSubtitle,
  date,
  setSermonList,
  selectedSundayHomiliesMonth,
  setSelectedSundayHomiliesMonth,
  sundayHomiliesYear,
  setSundayHomiliesYear,
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
      setSelectedSundayHomiliesMonth(null);
      setSermonList((oldSermonList) => {
        return oldSermonList.filter((list) => list.listTagAndPosition?.listTag !== ListTag.SUNDAY_HOMILY_MONTH);
      });
    }
  }, [sermonSubtitle, setSelectedSundayHomiliesMonth, setSermonList]);

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
            onChange={async (_, newValue) => {
              setSelectedSundayHomiliesMonth(newValue);
              setSermonList((oldSermonList) => {
                if (!newValue) {
                  return oldSermonList.filter(
                    (list) => list.listTagAndPosition?.listTag !== ListTag.SUNDAY_HOMILY_MONTH
                  );
                }
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
            renderInput={(params) => <TextField {...params} required label="Month" />}
          />
        ))}
    </>
  );
}

export default memo(SundayHomilyMonthSelector);
