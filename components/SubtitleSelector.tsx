import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import { FunctionComponent, Dispatch, SetStateAction, memo } from 'react';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import { List, ListType, ListWithHighlight } from '../types/List';
import { Sermon } from '../types/SermonTypes';
import { UploaderFieldError } from '../context/types';
import { getErrorMessage, showError } from './uploaderComponents/utils';

interface SubtitleSelectorProps {
  sermonList: List[];
  subtitle: string;
  setSermonList: Dispatch<SetStateAction<List[]>>;
  setSermon: Dispatch<SetStateAction<Sermon>>;
  subtitles: List[];
  subtitleError?: UploaderFieldError;
  setSubtitleError: (error: boolean, message: string) => void;
}

const SubtitleSelector: FunctionComponent<SubtitleSelectorProps> = (props: SubtitleSelectorProps) => {
  return (
    <Box display="flex" gap={1} width={1} alignItems="center">
      <Autocomplete
        fullWidth
        value={props.subtitles.find((subtitle) => subtitle.name === props.subtitle) || null}
        onBlur={() => {
          console.log(props.sermonList);
          if (!props.subtitle) {
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
        id="list-input"
        options={props.subtitles}
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
        renderOption={(props, option: ListWithHighlight) => (
          <ListItem {...props} key={option.id}>
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
        )}
        getOptionLabel={(option: ListWithHighlight) => option.name}
        isOptionEqualToValue={(option, value) =>
          value.name === undefined || option.name === undefined || option.id === value.id
        }
        renderInput={(params) => (
          <TextField
            {...params}
            required
            error={showError(props.subtitleError)}
            helperText={getErrorMessage(props.subtitleError)}
            label="Subtitle"
          />
        )}
      />
    </Box>
  );
};

export default memo(SubtitleSelector);
