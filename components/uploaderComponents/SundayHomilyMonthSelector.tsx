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
import { getSundayHomiliesFromBundle } from '../../utils/bundleHelpers';
import { LocalSearch } from '../../utils/localSearch';

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
  const [allSundayHomilies, setAllSundayHomilies] = useState<SundayHomiliesMonthList[]>([]);
  const [sundayHomilySearch, setSundayHomilySearch] = useState<LocalSearch<SundayHomiliesMonthList> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

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

      try {
        // Load all sunday homilies from bundle if not already loaded
        if (allSundayHomilies.length === 0) {
          const homiliesFromBundle = await getSundayHomiliesFromBundle();
          const typedHomilies = homiliesFromBundle as SundayHomiliesMonthList[];
          setAllSundayHomilies(typedHomilies);
          // Initialize local search
          const search = new LocalSearch(typedHomilies, 'name', 'sunday homilies');
          setSundayHomilySearch(search);
        }

        // Filter by year locally
        const filteredByYear = allSundayHomilies.filter(
          (homily) => homily.listTagAndPosition.year === year
        );
        setSundayHomiliesMonths(filteredByYear);
      } catch (error) {
         
        console.error('Error loading sunday homilies from bundle, falling back to Firestore:', error);
        // Fallback to original Firestore query
        const sundayHomiliesMonthsQuery = query(
          collection(firestore, 'lists'),
          where('listTagAndPosition.listTag', '==', ListTag.SUNDAY_HOMILY_MONTH),
          where('listTagAndPosition.year', '==', year),
          orderBy('listTagAndPosition.position', 'asc')
        ).withConverter(listConverter);
        const homilies = (await getDocs(sundayHomiliesMonthsQuery)).docs.map((doc) => doc.data() as SundayHomiliesMonthList);
        setSundayHomiliesMonths(homilies);
        // Initialize local search with fallback data (all homilies from this year only)
        const search = new LocalSearch(homilies, 'name', 'sunday homilies');
        setSundayHomilySearch(search);
      } finally {
        setLoadingSundayHomiliesMonths(false);
      }
    },
    [selectedSundayHomiliesMonth, setSelectedSundayHomiliesMonth, setSermonList, allSundayHomilies]
  );

  useEffect(() => {
    if (sermonSubtitle !== SUNDAY_HOMILIES_STRING) {
      setSundayHomiliesMonthError(false, '');
      setSelectedSundayHomiliesMonth(null);
      setSermonList((oldSermonList) => {
        return oldSermonList.filter((list) => list.listTagAndPosition?.listTag !== ListTag.SUNDAY_HOMILY_MONTH);
      });
    }

    if (sermonSubtitle === SUNDAY_HOMILIES_STRING && !selectedSundayHomiliesMonth) {
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
    if (sermonSubtitle === SUNDAY_HOMILIES_STRING) {
      fetchSundayHomiliesMonths(date.getFullYear());
    }
  }, [sermonSubtitle, date, fetchSundayHomiliesMonths]);

  // Update filtered months when allSundayHomilies changes
  useEffect(() => {
    if (allSundayHomilies.length > 0 && sermonSubtitle === SUNDAY_HOMILIES_STRING) {
      const filteredByYear = allSundayHomilies.filter(
        (homily) => homily.listTagAndPosition.year === sundayHomiliesYear
      );
      setSundayHomiliesMonths(filteredByYear);
    }
  }, [allSundayHomilies, sundayHomiliesYear, sermonSubtitle]);

  // Get filtered options based on search query and year
  const getFilteredOptions = () => {
    if (!sundayHomilySearch) return sundayHomiliesMonths;
    
    let items: SundayHomiliesMonthList[];
    
    if (!searchQuery.trim()) {
      // No search query - use all items from the search instance
      items = sundayHomilySearch.getAllItems();
    } else {
      // Search and get results
      items = sundayHomilySearch.search(searchQuery).map(result => result.item);
    }
    
    // Filter by year
    return items.filter((homily) => homily.listTagAndPosition.year === sundayHomiliesYear);
  };

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
            onInputChange={(_, newInputValue) => {
              setSearchQuery(newInputValue);
            }}
            filterOptions={(options) => options} // Disable built-in filtering since we handle it
            id="sunday-homilies-months-input"
            options={getFilteredOptions()}
            getOptionLabel={(option: List) => option.name}
            renderOption={(props, option: List) => {
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
