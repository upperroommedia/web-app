import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Typography from '@mui/material/Typography';
import { SermonList } from '../types/SermonList';
import { uploadStatus } from '../types/SermonTypes';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ReportProblemRoundedIcon from '@mui/icons-material/ReportProblemRounded';
import Tooltip from '@mui/material/Tooltip';
import Stack from '@mui/material/Stack';
import Checkbox from '@mui/material/Checkbox';
import { useEffect, useState } from 'react';
import FormControlLabel from '@mui/material/FormControlLabel';
import Button, { ButtonPropsColorOverrides } from '@mui/material/Button';
import { OverridableStringUnion } from '@mui/types';
import CircularProgress from '@mui/material/CircularProgress';
import { reportHandledError } from '../utils/reportHandledError';

interface UploadStatusListProps {
  sectionTitle: string;
  sermonListItems: SermonList[];
  buttonAction: (lists: SermonList[]) => Promise<void>;
  allSelectedButtonAction?: (lists?: SermonList[]) => Promise<void>;
  buttonLabel: string;
  secondaryButtonAction?: (lists: SermonList[]) => Promise<void>;
  secondaryButtonLabel?: string;
  secondaryButtonColorVariant?: OverridableStringUnion<
    'inherit' | 'primary' | 'secondary' | 'success' | 'error' | 'info' | 'warning',
    ButtonPropsColorOverrides
  >;
  buttonColorVariant?: OverridableStringUnion<
    'inherit' | 'primary' | 'secondary' | 'success' | 'error' | 'info' | 'warning',
    ButtonPropsColorOverrides
  >;
}

const UploadStatusList = ({
  sectionTitle,
  sermonListItems,
  buttonAction,
  allSelectedButtonAction,
  buttonLabel,
  secondaryButtonAction,
  secondaryButtonLabel,
  secondaryButtonColorVariant,
  buttonColorVariant,
}: UploadStatusListProps) => {
  const [loadingAction, setLoadingAction] = useState<'primary' | 'secondary' | null>(null);
  const [loadingListIds, setLoadingListIds] = useState<Set<string>>(new Set());
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const validIds = new Set(sermonListItems.map((item) => item.id));
    setCheckedIds((previousCheckedIds) => {
      let changed = false;
      const nextCheckedIds = new Set<string>();

      previousCheckedIds.forEach((id) => {
        if (validIds.has(id)) {
          nextCheckedIds.add(id);
        } else {
          changed = true;
        }
      });

      return changed ? nextCheckedIds : previousCheckedIds;
    });
  }, [sermonListItems]);

  if (sermonListItems.length === 0) {
    return <></>;
  }

  const selectedCount = sermonListItems.filter((item) => checkedIds.has(item.id)).length;
  const hasSelection = selectedCount > 0;
  const allSelected = selectedCount === sermonListItems.length;
  const someSelected = selectedCount > 0 && selectedCount < sermonListItems.length;
  const isLoading = loadingAction !== null;
  const runAction = async (action: 'primary' | 'secondary') => {
    const selectedItems = sermonListItems.filter((item) => checkedIds.has(item.id));
    if (selectedItems.length === 0) return;

    setLoadingAction(action);
    setLoadingListIds(new Set(selectedItems.map((item) => item.id)));
    try {
      if (action === 'primary') {
        if (allSelectedButtonAction && selectedItems.length === sermonListItems.length) {
          await allSelectedButtonAction(selectedItems);
          return;
        }
        await buttonAction(selectedItems);
        return;
      }

      if (secondaryButtonAction) {
        await secondaryButtonAction(selectedItems);
      }
    } catch (error) {
      reportHandledError(error, {
        area: 'upload-status-list',
        action,
        extras: {
          sectionTitle,
          selectedItemIds: selectedItems.map((item) => item.id),
        },
      });
      alert(error);
    } finally {
      setLoadingAction(null);
      setLoadingListIds(new Set());
    }
  };

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
            checked={allSelected}
            indeterminate={someSelected}
            onChange={(event) =>
              setCheckedIds(
                event.target.checked
                  ? new Set(sermonListItems.map((item) => item.id))
                  : new Set()
              )
            }
          />
        }
      />
      <List sx={{ p: 0 }}>
        {sermonListItems.map((sermonList) => {
          return (
            <ListItem key={sermonList.id} sx={{ display: 'flex', justifyContent: 'space-between' }}>
              <Stack gap={1} flexDirection="row" alignItems="center" marginRight={2}>
                <Checkbox
                  disableRipple
                  inputProps={{ 'aria-label': 'controlled' }}
                  checked={checkedIds.has(sermonList.id)}
                  onChange={(event) =>
                    setCheckedIds((previousCheckedIds) => {
                      const nextCheckedIds = new Set(previousCheckedIds);
                      if (event.target.checked) {
                        nextCheckedIds.add(sermonList.id);
                      } else {
                        nextCheckedIds.delete(sermonList.id);
                      }
                      return nextCheckedIds;
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
              {loadingListIds.has(sermonList.id) ? (
                <CircularProgress size="1.25rem" />
              ) : sermonList.uploadStatus?.status === uploadStatus.UPLOADED ? (
                <CheckCircleIcon color="success" />
              ) : sermonList.uploadStatus?.status === uploadStatus.ERROR ? (
                <Tooltip title={sermonList.uploadStatus.reason} placement="top">
                  <ReportProblemRoundedIcon color="error" />
                </Tooltip>
              ) : null}
            </ListItem>
          );
        })}
      </List>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <Button
          color={buttonColorVariant}
          variant="contained"
          disabled={!hasSelection || isLoading}
          onClick={() => runAction('primary')}
          sx={{ flex: 1 }}
        >
          {loadingAction === 'primary' ? <CircularProgress size="1.5rem" /> : buttonLabel}
        </Button>
        {secondaryButtonAction && secondaryButtonLabel && (
          <Button
            color={secondaryButtonColorVariant ?? 'secondary'}
            variant="outlined"
            disabled={!hasSelection || isLoading}
            onClick={() => runAction('secondary')}
            sx={{ flex: 1 }}
          >
            {loadingAction === 'secondary' ? <CircularProgress size="1.5rem" /> : secondaryButtonLabel}
          </Button>
        )}
      </Stack>
    </Stack>
  );
};

export default UploadStatusList;
