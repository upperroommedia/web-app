import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { FunctionComponent, Dispatch, SetStateAction, memo, useMemo, useState } from 'react';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import { List, ListType, ListWithHighlight } from '../types/List';
import { Sermon } from '../types/SermonTypes';
import { UploaderFieldError } from '../context/types';
import { getErrorMessage, showError } from './uploaderComponents/utils';
import { LocalSearch } from '../utils/localSearch';

interface SubtitleSelectorProps {
  sermonList: List[];
  subtitle: string;
  setSermonList: Dispatch<SetStateAction<List[]>>;
  setSermon: Dispatch<SetStateAction<Sermon>>;
  subtitles: List[];
  subtitleError?: UploaderFieldError;
  setSubtitleError: (error: boolean, message: string) => void;
  isLoading?: boolean;
  required?: boolean;
}

const SubtitleSelector: FunctionComponent<SubtitleSelectorProps> = (props: SubtitleSelectorProps) => {
  const [searchQuery, setSearchQuery] = useState('');

  const localSearch = useMemo(() => {
    if (props.subtitles.length === 0) {
      return null;
    }
    return new LocalSearch(props.subtitles, 'name', 'subtitles');
  }, [props.subtitles]);

  const filteredSubtitles = useMemo(() => {
    if (!localSearch || !searchQuery.trim()) {
      return [...props.subtitles].sort((a, b) => a.name.localeCompare(b.name));
    }
    return localSearch.search(searchQuery, 50).map((result) => result.item);
  }, [localSearch, props.subtitles, searchQuery]);

  return (
    <Box display="flex" gap={1} width={1} alignItems="center">
      <Autocomplete
        fullWidth
        value={props.subtitles.find((subtitle) => subtitle.name === props.subtitle) || null}
        options={filteredSubtitles}
        // Disable Material-UI's built-in filtering to preserve our search order
        filterOptions={(options) => options}
        loading={props.isLoading}
        onInputChange={(_, newInputValue) => {
          setSearchQuery(newInputValue);
        }}
        onBlur={() => {
          if (props.required !== false && !props.subtitle) {
            props.setSubtitleError(true, 'You must select at least one subtitle');
          } else {
            props.setSubtitleError(false, '');
          }
        }}
        onChange={async (_, newValue) => {
          if (
            newValue === null &&
            props.sermonList.find((list) => list.type === ListType.CATEGORY_LIST) !== undefined
          ) {
            // user cleared the selection - remove sermon from list
            props.setSermon((oldSermon) => ({ ...oldSermon, subtitle: '' }));
            props.setSermonList((oldSermonList) =>
              oldSermonList.filter((list) => list.type !== ListType.CATEGORY_LIST)
            );
          } else if (!newValue) {
            // cleared selector with no existing sermon list
            props.setSermon((oldSermon) => ({ ...oldSermon, subtitle: '' }));
          } else if (newValue) {
            // a new value has been selected
            props.setSubtitleError(false, '');
            props.setSermon((oldSermon) => ({ ...oldSermon, subtitle: newValue.name }));
            const listWithSameName = props.sermonList.find((list) => list.name === newValue.name);
            if (
              props.sermonList.find((list) => list.type === ListType.SERIES && !list.listTagAndPosition) === undefined
            ) {
              props.setSermonList((oldSermonList) => [
                ...oldSermonList.filter((list) => list.type !== ListType.CATEGORY_LIST),
                newValue,
              ]);
            } else if (listWithSameName !== undefined) {
              props.setSermonList((oldSermonList) => [
                ...oldSermonList.filter((list) => list.name !== newValue.name),
                newValue,
              ]);
            }
          }
        }}
        id="subtitle-selector-input"
        renderTags={(list, _) => {
          return list.map((list) => (
            <Chip
              key={list.id}
              label={list.name}
              avatar={
                <AvatarWithDefaultImage
                  defaultImageURL="/user.png"
                  altName={list.name}
                  width={24}
                  height={24}
                  borderRadius={12}
                  image={list.images?.find((image) => image.type === 'square')}
                />
              }
            />
          ));
        }}
        renderOption={(props, option: ListWithHighlight) => {
          const { key: _key, ...optionProps } = props;
          return (
            <ListItem key={option.id} {...optionProps}>
              <AvatarWithDefaultImage
                defaultImageURL="/user.png"
                altName={option.name}
                width={30}
                height={30}
                image={option.images?.find((image) => image.type === 'square')}
                borderRadius={5}
                sx={{ marginRight: '15px' }}
              />
              <div>{option.name}</div>
            </ListItem>
          );
        }}
        getOptionLabel={(option: ListWithHighlight) => option.name}
        isOptionEqualToValue={(option, value) =>
          value.name === undefined || option.name === undefined || option.id === value.id
        }
        renderInput={(params) => {
          const selectedSubtitle = props.subtitles.find((subtitle) => subtitle.name === props.subtitle);
          const subtitleHasError = showError(props.subtitleError);
          const subtitleHelperText = subtitleHasError ? getErrorMessage(props.subtitleError) : undefined;

          return (
            <TextField
              {...params}
              required={props.required !== false}
              error={subtitleHasError}
              helperText={subtitleHelperText}
              sx={{
                '& .MuiFormHelperText-root': {
                  marginTop: subtitleHasError ? undefined : 0,
                },
                '& .MuiFormHelperText-root:empty': {
                  display: 'none',
                },
              }}
              label="Subtitle"
              InputProps={{
                ...params.InputProps,
                startAdornment: selectedSubtitle && (
                  <AvatarWithDefaultImage
                    defaultImageURL="/user.png"
                    altName={selectedSubtitle.name}
                    width={30}
                    height={30}
                    borderRadius={5}
                    image={selectedSubtitle.images?.find((image) => image.type === 'square')}
                    sx={{ marginRight: 1 }}
                  />
                ),
              }}
            />
          );
        }}
      />
    </Box>
  );
};

export default memo(SubtitleSelector);
