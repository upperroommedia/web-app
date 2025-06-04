import React, { useEffect, useState } from 'react';
import { BIBLE_STUDIES_STRING } from './consts';
import firestore, { collection, getDocs, orderBy, query, where } from '../../firebase/firestore';
import { List, ListTag, listConverter } from '../../types/List';
import CircularProgress from '@mui/material/CircularProgress';
import Autocomplete from '@mui/material/Autocomplete';
import ListItem from '@mui/material/ListItem';
import TextField from '@mui/material/TextField';
import { UploaderFieldError } from '../../context/types';
import { getErrorMessage, showError } from './utils';
import { getBibleChaptersFromBundle } from '../../utils/bundleHelpers';
import { LocalSearch } from '../../utils/localSearch';

interface BibleChapterSelectorProps {
  sermonSubtitle: string;
  setSermonList: React.Dispatch<React.SetStateAction<List[]>>;
  selectedChapter: List | null;
  setSelectedChapter: React.Dispatch<React.SetStateAction<List | null>>;
  bibleChapterError?: UploaderFieldError;
  setBibleChapterError: (error: boolean, message: string, intitialState?: boolean) => void;
}

export default function BibleChapterSelector({
  sermonSubtitle,
  setSermonList,
  selectedChapter,
  setSelectedChapter,
  bibleChapterError,
  setBibleChapterError,
}: BibleChapterSelectorProps) {
  const [loadingBibleChapters, setLoadingBibleChapters] = useState(false);
  const [bibleChapters, setBibleChapters] = useState<List[]>([]);
  const [bibleChapterSearch, setBibleChapterSearch] = useState<LocalSearch<List> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (sermonSubtitle !== BIBLE_STUDIES_STRING) {
      setBibleChapterError(false, '');
      setSelectedChapter(null);
      setSermonList((oldSermonList) => {
        return oldSermonList.filter((list) => list.listTagAndPosition?.listTag !== ListTag.BIBLE_CHAPTER);
      });
    } else if (sermonSubtitle === BIBLE_STUDIES_STRING && bibleChapters.length === 0) {
      const fetchBibleChapters = async () => {
        setLoadingBibleChapters(true);
        try {
          console.log('Loading bible chapters from bundle...');
          const chaptersFromBundle = await getBibleChaptersFromBundle();
          setBibleChapters(chaptersFromBundle);
          // Initialize local search
          const search = new LocalSearch(chaptersFromBundle, 'name', 'bible chapters');
          setBibleChapterSearch(search);
          console.log(`Loaded ${chaptersFromBundle.length} bible chapters from bundle`);
        } catch (error) {
          console.error('Error loading bible chapters from bundle, falling back to Firestore:', error);
          // Fallback to original Firestore query
          const bibleChapterQuery = query(
            collection(firestore, 'lists'),
            where('listTagAndPosition.listTag', '==', ListTag.BIBLE_CHAPTER),
            orderBy('listTagAndPosition.position', 'asc')
          ).withConverter(listConverter);
          const chapters = (await getDocs(bibleChapterQuery)).docs.map((doc) => doc.data());
          setBibleChapters(chapters);
          // Initialize local search with fallback data
          const search = new LocalSearch(chapters, 'name', 'bible chapters');
          setBibleChapterSearch(search);
        } finally {
          setLoadingBibleChapters(false);
        }
      };
      fetchBibleChapters();
    }
    if (sermonSubtitle === BIBLE_STUDIES_STRING && !selectedChapter) {
      setBibleChapterError(true, 'You must select a bible chapter', true);
    }
  }, [sermonSubtitle, bibleChapters.length, setSelectedChapter, setSermonList, setBibleChapterError, selectedChapter]);

  // Get filtered options based on search query
  const getFilteredOptions = () => {
    if (!bibleChapterSearch) return bibleChapters;
    
    if (!searchQuery.trim()) {
      return bibleChapterSearch.getAllItems();
    }
    
    return bibleChapterSearch.search(searchQuery).map(result => result.item);
  };

  return (
    <>
      {/* mui autocomplete of bible chapters shown when sermon.subtitle is BIBLE_STUDIES_STRING */}
      {sermonSubtitle === BIBLE_STUDIES_STRING &&
        (loadingBibleChapters ? (
          <CircularProgress />
        ) : (
          <Autocomplete
            fullWidth
            value={selectedChapter || null}
            isOptionEqualToValue={(option, value) => option?.id === value?.id}
            onBlur={() => {
              if (!selectedChapter) {
                setBibleChapterError(true, 'You must select at least one subtitle');
              } else {
                setBibleChapterError(false, '');
              }
            }}
            onChange={async (_, newValue) => {
              setSelectedChapter(newValue);
              setSermonList((oldSermonList) => {
                if (!newValue) {
                  return oldSermonList.filter((list) => list.listTagAndPosition?.listTag !== ListTag.BIBLE_CHAPTER);
                }
                setBibleChapterError(false, '');
                const filteredList = oldSermonList.filter(
                  (list) =>
                    list.name !== BIBLE_STUDIES_STRING && list.listTagAndPosition?.listTag !== ListTag.BIBLE_CHAPTER
                );
                return [...filteredList, newValue];
              });
            }}
            onInputChange={(_, newInputValue) => {
              setSearchQuery(newInputValue);
            }}
            filterOptions={(options) => options} // Disable built-in filtering since we handle it
            id="bible-chapter-input"
            options={getFilteredOptions()}
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
                error={showError(bibleChapterError)}
                helperText={getErrorMessage(bibleChapterError)}
                label="Bible Chapter"
              />
            )}
          />
        ))}
    </>
  );
}
