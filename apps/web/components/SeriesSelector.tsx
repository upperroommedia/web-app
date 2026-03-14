/**
 * SeriesSelector: Single-select autocomplete for choosing a media series
 * - Users can only see series they own
 * - Admins can see all series (with owner indicated)
 * - Includes button to create new series
 * - Links to series details page for selected series
 */
import TextField from '@mui/material/TextField';
import ListItem from '@mui/material/ListItem';
import Autocomplete from '@mui/material/Autocomplete';
import InputAdornment from '@mui/material/InputAdornment';
import { FunctionComponent, Dispatch, SetStateAction, useState, useEffect, memo } from 'react';
import AvatarWithDefaultImage from './AvatarWithDefaultImage';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import NewSeriesPopup from './NewSeriesPopup';
import firestore, { query, collection, getDocs, where, limit, orderBy, QueryConstraint } from '../firebase/firestore';
import AddIcon from '@mui/icons-material/Add';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Series, seriesConverter } from '../types/Series';
import useAuth from '../context/user/UserContext';
import Link from 'next/link';

interface SeriesSelectorProps {
  selectedSeries: Series | null;
  setSelectedSeries: Dispatch<SetStateAction<Series | null>>;
  disabled?: boolean;
  required?: boolean;
  error?: boolean;
  helperText?: string;
}

const SeriesSelector: FunctionComponent<SeriesSelectorProps> = (props) => {
  const { user } = useAuth();
  const [newSeriesPopup, setNewSeriesPopup] = useState<boolean>(false);
  const [allSeriesArray, setAllSeriesArray] = useState<Series[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const isAdmin = user?.isAdmin() ?? false;

  // Fetch series on mount and when input changes
  useEffect(() => {
    if (!user) return;

    const fetchSeries = async () => {
      setLoading(true);
      try {
        const targetLimit = 10;
        const queryConstraints: QueryConstraint[] = [
          limit(targetLimit),
          orderBy('updatedAt', 'desc'),
        ];

        // Non-admins can only see their own series
        if (!isAdmin) {
          queryConstraints.push(where('ownerId', '==', user.uid));
        }

        const seriesQuery = query(
          collection(firestore, 'series'),
          ...queryConstraints
        ).withConverter(seriesConverter);
        
        const seriesSnapshot = await getDocs(seriesQuery);
        const seriesList = seriesSnapshot.docs.map((doc) => doc.data());
        
        // Filter by input value if provided
        const filtered = inputValue
          ? seriesList.filter((s) => 
              s.name.toLowerCase().includes(inputValue.toLowerCase())
            )
          : seriesList;

        setAllSeriesArray(filtered);
      } catch (error) {
        console.error('Error fetching series:', error);
        setAllSeriesArray([]);
      }
      setLoading(false);
    };

    fetchSeries();
  }, [user, isAdmin, inputValue]);

  // Add newly created series to the list and select it
  const handleSeriesCreated = (newSeries: Series) => {
    setAllSeriesArray((prev) => [newSeries, ...prev]);
    props.setSelectedSeries(newSeries);
  };

  return (
    <>
      <Box display="flex" gap={1} width={1} alignItems="center">
        <Autocomplete
          fullWidth
          value={props.selectedSeries}
          loading={loading}
          disabled={props.disabled}
          onChange={(_, newValue) => {
            props.setSelectedSeries(newValue);
          }}
          inputValue={inputValue}
          onInputChange={(_, newInputValue) => {
            setInputValue(newInputValue);
          }}
          id="series-selector-input"
          options={allSeriesArray}
          getOptionLabel={(option: Series) => option.name}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          renderOption={(renderProps, option: Series) => (
            <ListItem {...renderProps} key={option.id}>
              <AvatarWithDefaultImage
                defaultImageURL="/sermon_default.png"
                altName={option.name}
                width={30}
                height={30}
                image={option.images?.find((image) => image.type === 'square')}
                borderRadius={5}
                sx={{ marginRight: '15px' }}
              />
              <Box display="flex" flexDirection="column" flex={1}>
                <Typography variant="body1">{option.name}</Typography>
                {isAdmin && option.ownerId !== user?.uid && (
                  <Typography variant="caption" color="text.secondary">
                    {option.subsplashId ? 'Published' : 'Draft'} • Owner: {option.ownerId.slice(0, 8)}...
                  </Typography>
                )}
                {(!isAdmin || option.ownerId === user?.uid) && (
                  <Typography variant="caption" color="text.secondary">
                    {option.subsplashId ? 'Published' : 'Draft'} • {option.itemCount} items
                  </Typography>
                )}
              </Box>
            </ListItem>
          )}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Series"
              placeholder="Select a series..."
              required={props.required}
              error={props.error}
              helperText={props.helperText}
              InputProps={{
                ...params.InputProps,
                startAdornment: props.selectedSeries ? (
                  <InputAdornment position="start">
                    <AvatarWithDefaultImage
                      defaultImageURL="/sermon_default.png"
                      altName={props.selectedSeries.name}
                      width={30}
                      height={30}
                      image={props.selectedSeries.images?.find((image) => image.type === 'square')}
                      borderRadius={5}
                    />
                  </InputAdornment>
                ) : null,
              }}
            />
          )}
        />
        
        {/* Link to series details page if a series is selected */}
        {props.selectedSeries && (
          <Tooltip title="View series details">
            <Link href={`/admin/series/${props.selectedSeries.id}`} passHref target="_blank">
              <IconButton size="small" sx={{ flexShrink: 0 }}>
                <OpenInNewIcon />
              </IconButton>
            </Link>
          </Tooltip>
        )}

        {/* Add new series button */}
        <Tooltip title="Create new series">
          <IconButton
            size="small"
            sx={{ flexShrink: 0 }}
            onClick={() => setNewSeriesPopup(true)}
            disabled={props.disabled}
          >
            <AddIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <NewSeriesPopup
        open={newSeriesPopup}
        setOpen={setNewSeriesPopup}
        onSeriesCreated={handleSeriesCreated}
      />
    </>
  );
};

export default memo(SeriesSelector);
