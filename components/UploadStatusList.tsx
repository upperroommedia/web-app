import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Typography from '@mui/material/Typography';
import { SermonList } from '../types/SermonList';
import { uploadStatus } from '../types/SermonTypes';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ReportProblemRoundedIcon from '@mui/icons-material/ReportProblemRounded';
import CloudUploadRoundedIcon from '@mui/icons-material/CloudUploadRounded';
import Tooltip from '@mui/material/Tooltip';
import Stack from '@mui/material/Stack';
import Checkbox from '@mui/material/Checkbox';
import { useState } from 'react';
import FormControlLabel from '@mui/material/FormControlLabel';
import Button, { ButtonPropsColorOverrides } from '@mui/material/Button';
import { OverridableStringUnion } from '@mui/types';
interface UploadStatusListProps {
  sectionTitle: string;
  sermonListItems: SermonList[];
  buttonAction: (lists: SermonList[]) => Promise<void>;
  buttonLabel: string;
  buttonColorVariant?: OverridableStringUnion<
    'inherit' | 'primary' | 'secondary' | 'success' | 'error' | 'info' | 'warning',
    ButtonPropsColorOverrides
  >;
}

const UploadStatusList = ({
  sectionTitle,
  sermonListItems,
  buttonAction,
  buttonLabel,
  buttonColorVariant,
}: UploadStatusListProps) => {
  if (sermonListItems.length === 0) {
    return <></>;
  }

  const [checked, setChecked] = useState<boolean[]>(new Array(sermonListItems.length).fill(false));
  console.log(checked);
  return (
    <Stack>
      <Typography variant="h5" alignSelf="center">
        {sectionTitle}
      </Typography>
      <FormControlLabel
        label="Select All"
        control={
          <Checkbox
            disableRipple
            inputProps={{ 'aria-label': 'controlled' }}
            checked={checked.every((value) => value === true)}
            indeterminate={checked.some((value) => value === true) && checked.some((value) => value === false)}
            onChange={(event) => setChecked(checked.map(() => event.target.checked))}
          />
        }
      />
      <List sx={{ p: 0 }}>
        {sermonListItems.map((sermonList, index) => {
          return (
            <ListItem key={sermonList.id} sx={{ display: 'flex', justifyContent: 'space-between' }}>
              <Stack gap={1} flexDirection="row" alignItems="center">
                <Checkbox
                  disableRipple
                  inputProps={{ 'aria-label': 'controlled' }}
                  checked={checked[index]}
                  onChange={(event) =>
                    setChecked((previousChecked) => {
                      previousChecked[index] = event.target.checked;
                      return [...previousChecked];
                    })
                  }
                />
                <AvatarWithDefaultImage
                  width={30}
                  height={30}
                  altName={sermonList.name}
                  borderRadius={5}
                  image={sermonList.images?.find((image) => image.type === 'square')}
                />
                <Typography>{sermonList.name}</Typography>
              </Stack>
              {sermonList.uploadStatus?.status === uploadStatus.UPLOADED ? (
                <CheckCircleIcon color="success" />
              ) : sermonList.uploadStatus?.status === uploadStatus.ERROR ? (
                <Tooltip title={sermonList.uploadStatus.reason} placement="top">
                  <ReportProblemRoundedIcon color="error" />
                </Tooltip>
              ) : (
                <CloudUploadRoundedIcon color="primary" />
              )}
            </ListItem>
          );
        })}
      </List>
      <Button
        color={buttonColorVariant}
        variant="contained"
        disabled={checked.every((value) => value === false)}
        onClick={async () => {
          const selectedItems = sermonListItems.filter((_, index) => checked[index]);
          await buttonAction(selectedItems);
        }}
      >
        {buttonLabel}
      </Button>
    </Stack>
  );
};

export default UploadStatusList;
