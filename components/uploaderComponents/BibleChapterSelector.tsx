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
        // fetch bible chapters
        const bibleChapterQuery = query(
          collection(firestore, 'lists'),
          where('listTagAndPosition.listTag', '==', ListTag.BIBLE_CHAPTER),
          orderBy('listTagAndPosition.position', 'asc')
        ).withConverter(listConverter);
        setBibleChapters((await getDocs(bibleChapterQuery)).docs.map((doc) => doc.data()));
        setLoadingBibleChapters(false);
      };
      fetchBibleChapters();
    }
    if (sermonSubtitle === BIBLE_STUDIES_STRING && !selectedChapter) {
      setBibleChapterError(true, 'You must select a bible chapter', true);
    }
  }, [sermonSubtitle, bibleChapters.length, setSelectedChapter, setSermonList, setBibleChapterError, selectedChapter]);

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
            id="bible-chapter-input"
            options={bibleChapters}
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
